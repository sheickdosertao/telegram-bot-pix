// webhook.js
const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const crypto = require('crypto'); // Para validação de hash da assinatura

// --- Variáveis de Configuração (Lidas de Variáveis de Ambiente) ---
require('dotenv').config();
const DATABASE_URL = process.env.DATABASE_URL;
const PAGSEGURO_WEBHOOK_SECRET = process.env.PAGSEGURO_WEBHOOK_SECRET;
const PAGBANK_API_TOKEN = process.env.PAGBANK_API_TOKEN;
const PAGBANK_EMAIL = process.env.PAGBANK_EMAIL;
const app = express();

// Middleware para capturar o body raw (necessário para validação de assinatura)
app.use('/webhook', express.raw({ type: 'application/json' }));
// Para outras rotas, use JSON parser normal
app.use(express.json());

// --- Conexão PostgreSQL com Sequelize ---
const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: process.env.NODE_ENV === 'production' ? {
            require: true,
            rejectUnauthorized: false
        } : false
    }
});

// --- Definição dos Modelos (DEVE SER A MESMA DO bot.js para consistência) ---

const User = sequelize.define('User', {
    telegramId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
        primaryKey: true
    },
    username: {
        type: DataTypes.STRING,
        defaultValue: 'Não informado'
    },
    balance: {
        type: DataTypes.FLOAT,
        defaultValue: 0.0
    },
    isAdmin: { // Coluna para controle de administração
        type: DataTypes.BOOLEAN,
        defaultValue: false
    }
}, {
    timestamps: false
});

const Transaction = sequelize.define('Transaction', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    type: {
        type: DataTypes.ENUM('deposit', 'purchase', 'refund', 'admin_adjustment'),
        allowNull: false
    },
    amount: {
        type: DataTypes.FLOAT,
        allowNull: false
    },
    description: {
        type: DataTypes.STRING
    },
    timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
});

// --- Relação entre Modelos ---
User.hasMany(Transaction, { foreignKey: 'userId', onDelete: 'CASCADE' });
Transaction.belongsTo(User, { foreignKey: 'userId' });

/**
 * Função para garantir que o tipo ENUM 'enum_Transactions_type' existe e contém 'admin_adjustment'.
 */
async function ensureEnumType() {
    try {
        const [results] = await sequelize.query(`
            SELECT enumlabel
            FROM pg_enum
            WHERE enumtypid = (
                SELECT oid FROM pg_type WHERE typname = 'enum_Transactions_type'
            ) AND enumlabel = 'admin_adjustment';
        `);

        if (results.length === 0) {
            await sequelize.query(`
                ALTER TYPE "public"."enum_Transactions_type" ADD VALUE 'admin_adjustment' AFTER 'refund';
            `);
            console.log('ENUM value "admin_adjustment" added to "enum_Transactions_type".');
        } else {
            console.log('ENUM value "admin_adjustment" already exists in "enum_Transactions_type".');
        }
    } catch (error) {
        console.warn('Não foi possível verificar/alterar o tipo ENUM "enum_Transactions_type":', error.message);
    }
}

/**
 * Função para validar a assinatura do webhook do PagSeguro
 * @param {Buffer} payload - Body raw da requisição
 * @param {string} signature - Assinatura recebida no header
 * @param {string} secret - Secret configurado no PagSeguro
 * @returns {boolean} - True se a assinatura for válida
 */
function validatePagSeguroSignature(payload, signature, secret) {
    if (!signature || !secret) {
        return false;
    }

    // Remove o prefixo se existir (ex: "sha256=")
    const cleanSignature = signature.replace(/^sha256=/, '');
    
    // Gera o hash esperado usando HMAC SHA256
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

    // Compara as assinaturas de forma segura
    return crypto.timingSafeEqual(
        Buffer.from(cleanSignature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
    );
}

// --- Sincronização do Banco de Dados ---
async function syncDatabase() {
    try {
        await ensureEnumType();
        await sequelize.sync({ alter: true }); 
        console.log('Banco de dados PostgreSQL sincronizado (webhook)!');
    } catch (err) {
        console.error('Erro ao sincronizar o banco de dados PostgreSQL no webhook:', err);
        process.exit(1);
    }
}

syncDatabase();

// Endpoint para receber notificações do PagSeguro
app.post('/webhook/pagseguro', async (req, res) => {
    try {
        // Parse do JSON do body raw
        const data = JSON.parse(req.body.toString());
        console.log('Webhook do PagSeguro recebido:', data);

        // --- VALIDAÇÃO DO WEBHOOK (Altamente Recomendado para Segurança) ---
        const signatureHeader = req.headers['x-pagseguro-signature'] || req.headers['x-signature'];

        if (!PAGSEGURO_WEBHOOK_SECRET) {
            console.warn('Variável PAGSEGURO_WEBHOOK_SECRET não configurada. A validação de webhook está desabilitada.');
        } else if (signatureHeader) {
            const isValidSignature = validatePagSeguroSignature(req.body, signatureHeader, PAGSEGURO_WEBHOOK_SECRET);
            if (!isValidSignature) {
                console.warn('Webhook recebido com assinatura inválida! Possível tentativa de ataque.');
                return res.status(403).json({ error: 'Forbidden: Invalid signature' });
            }
            console.log('Assinatura do webhook validada com sucesso.');
        } else if (PAGSEGURO_WEBHOOK_SECRET) {
            console.warn('Webhook recebido sem assinatura, mas PAGSEGURO_WEBHOOK_SECRET está configurado.');
            return res.status(403).json({ error: 'Forbidden: Missing signature' });
        }

        // Processa diferentes tipos de eventos do PagSeguro
        if (data.notificationCode) {
            // Webhook de notificação tradicional do PagSeguro
            await processPagSeguroNotification(data.notificationCode, res);
        } else if (data.charges && data.charges.length > 0) {
            // Webhook do PagSeguro V4 (novo formato)
            await processPagSeguroV4Webhook(data, res);
        } else {
            console.log('Formato de webhook não reconhecido:', data);
            res.status(200).json({ message: 'Webhook recebido mas não processado' });
        }

    } catch (parseError) {
        console.error('Erro ao fazer parse do JSON do webhook:', parseError);
        res.status(400).json({ error: 'JSON inválido' });
    }
});

/**
 * Processa webhook tradicional do PagSeguro (V3)
 */
async function processPagSeguroNotification(notificationCode, res) {
    try {
        // Consulta a API do PagSeguro para obter detalhes da transação
        const response = await fetch(`https://ws.pagseguro.uol.com.br/v3/transactions/notifications/${notificationCode}?email=${process.env.PAGBANK_EMAIL}&token=${PAGBANK_API_TOKEN}`);
        
        if (!response.ok) {
            throw new Error(`Erro na API do PagSeguro: ${response.status}`);
        }

        const xmlData = await response.text();
        console.log('Dados XML recebidos do PagSeguro:', xmlData);

        // Aqui você precisaria fazer o parse do XML
        // Para simplificar, vou mostrar como seria com a estrutura esperada
        const transactionData = parseXMLTransaction(xmlData);
        
        if (transactionData.status === 3 || transactionData.status === 4) { // Status 3 = Paga, 4 = Disponível
            await processPayment(transactionData, res);
        } else {
            console.log(`Transação ${transactionData.code} ainda não foi paga. Status: ${transactionData.status}`);
            res.status(200).json({ message: 'Transação não paga ainda' });
        }

    } catch (error) {
        console.error('Erro ao processar notificação do PagSeguro:', error);
        res.status(500).json({ error: 'Erro ao processar notificação' });
    }
}

/**
 * Processa webhook do PagSeguro V4 (novo formato)
 */
async function processPagSeguroV4Webhook(data, res) {
    try {
        const charge = data.charges[0]; // Primeira cobrança
        
        if (charge.status === 'PAID') {
            const referenceId = charge.reference_id;
            const amount = parseFloat(charge.amount.value) / 100; // PagSeguro envia em centavos

            await processPaymentFromReference(referenceId, amount, charge.id, res);
        } else {
            console.log(`Cobrança ${charge.id} ainda não foi paga. Status: ${charge.status}`);
            res.status(200).json({ message: 'Cobrança não paga ainda' });
        }

    } catch (error) {
        console.error('Erro ao processar webhook V4 do PagSeguro:', error);
        res.status(500).json({ error: 'Erro ao processar webhook V4' });
    }
}

/**
 * Processa o pagamento baseado no reference_id
 */
async function processPaymentFromReference(referenceId, amount, transactionId, res) {
    try {
        // Valida se reference_id tem o formato esperado
        if (!referenceId || !referenceId.includes('-')) {
            console.warn('Reference ID inválido ou no formato incorreto:', referenceId);
            return res.status(400).json({ error: 'Reference ID inválido' });
        }

        const telegramId = parseInt(referenceId.split('-')[0]);

        if (!isNaN(telegramId) && !isNaN(amount) && amount > 0) {
            const user = await User.findByPk(telegramId);
            if (user) {
                // Atualiza o saldo do usuário
                await user.increment('balance', { by: amount });
                
                // Registra a transação
                await Transaction.create({
                    userId: telegramId,
                    amount: amount,
                    type: 'deposit',
                    description: `Depósito PagSeguro confirmado (ID: ${transactionId})`
                });

                console.log(`Pagamento confirmado para usuário ${telegramId}. Valor: R$ ${amount}. Saldo atualizado.`);
                res.status(200).json({ message: 'Pagamento processado com sucesso' });
            } else {
                console.warn(`Usuário ${telegramId} não encontrado no DB para confirmação de pagamento (Ref: ${referenceId}).`);
                res.status(404).json({ error: 'Usuário não encontrado' });
            }
        } else {
            console.warn('Dados inválidos para processamento do pagamento:', { referenceId, amount, telegramId });
            res.status(400).json({ error: 'Dados inválidos no pagamento' });
        }
    } catch (error) {
        console.error('Erro ao processar pagamento:', error);
        res.status(500).json({ error: 'Erro interno ao processar pagamento' });
    }
}

/**
 * Função auxiliar para fazer parse do XML do PagSeguro (V3)
 * Esta é uma implementação simplificada - em produção use uma biblioteca como xml2js
 */
function parseXMLTransaction(xmlData) {
    // Implementação simplificada - em produção use xml2js ou similar
    const codeMatch = xmlData.match(/<code>(.*?)<\/code>/);
    const statusMatch = xmlData.match(/<status>(\d+)<\/status>/);
    const referenceMatch = xmlData.match(/<reference>(.*?)<\/reference>/);
    const grossAmountMatch = xmlData.match(/<grossAmount>([\d.]+)<\/grossAmount>/);

    return {
        code: codeMatch ? codeMatch[1] : null,
        status: statusMatch ? parseInt(statusMatch[1]) : null,
        reference: referenceMatch ? referenceMatch[1] : null,
        grossAmount: grossAmountMatch ? parseFloat(grossAmountMatch[1]) : null
    };
}

/**
 * Processa pagamento do formato V3 (XML)
 */
async function processPayment(transactionData, res) {
    try {
        const referenceId = transactionData.reference;
        const amount = transactionData.grossAmount;
        const transactionCode = transactionData.code;

        await processPaymentFromReference(referenceId, amount, transactionCode, res);
    } catch (error) {
        console.error('Erro ao processar pagamento V3:', error);
        res.status(500).json({ error: 'Erro ao processar pagamento V3' });
    }
}

// Endpoint de health check
app.get('/health', (_req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'webhook-pagseguro'
    });
});

// Middleware de tratamento de erros global
app.use((error, _req, res) => {
    console.error('Erro não tratado:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
});

// --- INICIALIZAÇÃO DO SERVIDOR WEBHOOK ---
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor de webhook PagSeguro rodando na porta ${PORT}`);
    console.log(`Health check disponível em: http://localhost:${PORT}/health`);
    console.log(`Webhook endpoint: http://localhost:${PORT}/webhook/pagseguro`);
});