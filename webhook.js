// webhook.js
const express = require('express');
const bodyParser = require('body-parser');
const { Sequelize, DataTypes } = require('sequelize');
// Opcional: const crypto = require('crypto'); // Para validação de hash da assinatura, se a Wegate usar

// --- Variáveis de Configuração (Lidas de Variáveis de Ambiente) ---
require('dotenv').config();
const DATABASE_URL = process.env.DATABASE_URL;
const WEGATE_WEBHOOK_SECRET = process.env.WEGATE_WEBHOOK_SECRET; 

const app = express();
// Certifique-se de que bodyParser.json() vem antes das rotas que o usam
app.use(bodyParser.json());

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
        type: DataTypes.ENUM('deposit', 'purchase', 'refund', 'admin_adjustment'), // Adicionado 'admin_adjustment'
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
 * Esta função tenta adicionar o valor 'admin_adjustment' se ele ainda não existir no ENUM.
 * Isso ajuda a contornar problemas de alteração de ENUM do Sequelize.
 */
async function ensureEnumType() {
    try {
        // Verifica se o valor 'admin_adjustment' já existe no ENUM
        const [results] = await sequelize.query(`
            SELECT enumlabel
            FROM pg_enum
            WHERE enumtypid = (
                SELECT oid FROM pg_type WHERE typname = 'enum_Transactions_type'
            ) AND enumlabel = 'admin_adjustment';
        `);

        if (results.length === 0) {
            // Se 'admin_adjustment' não existe, adiciona ao ENUM.
            // A cláusula 'ADD VALUE' requer que o tipo ENUM já exista.
            await sequelize.query(`
                ALTER TYPE "public"."enum_Transactions_type" ADD VALUE 'admin_adjustment' AFTER 'refund';
            `);
            console.log('ENUM value "admin_adjustment" added to "enum_Transactions_type".');
        } else {
            console.log('ENUM value "admin_adjustment" already exists in "enum_Transactions_type".');
        }
    } catch (error) {
        // Este catch lida com o caso em que o tipo ENUM "enum_Transactions_type" ainda não existe.
        // O Sequelize.sync({ alter: true }) irá criá-lo depois.
        // Ou, se houver um problema de "duplicate_object" mais profundo, o comando DROP TYPE manual é necessário.
        console.warn('Não foi possível verificar/alterar o tipo ENUM "enum_Transactions_type" (o tipo pode não existir ainda ou outro problema):', error.message);
    }
}

// --- Sincronização do Banco de Dados ---
async function syncDatabase() {
    try {
        // Primeiro, tente garantir que o tipo ENUM esteja configurado corretamente.
        // Isso é um passo proativo para lidar com as peculiaridades de alteração de ENUM do Sequelize.
        await ensureEnumType();

        // Em seguida, execute a operação de sincronização do Sequelize.
        // 'alter: true' tenta modificar a tabela existente para corresponder ao modelo.
        await sequelize.sync({ alter: true }); 
        console.log('Banco de dados PostgreSQL sincronizado (webhook)!');
    } catch (err) {
        console.error('Erro ao sincronizar o banco de dados PostgreSQL no webhook:', err);
        // O erro 'duplicar valor da chave viola a restrição de unicidade "pg_type_typname_nsp_index"'
        // geralmente acontece por um tipo ENUM já existente.
        // Se este erro persistir, você DEVE executar manualmente:
        // DROP TYPE IF EXISTS "enum_Transactions_type" CASCADE;
        // no seu DB via pgAdmin/psql.
        process.exit(1);
    }
}

syncDatabase(); // Chama a função assíncrona para iniciar a sincronização do DB

// Endpoint para receber notificações da Wegate
app.post('/webhook/wegate-pix', async (req, res) => {
    const data = req.body;
    console.log('Webhook da Wegate recebido:', data);

    // --- VALIDAÇÃO DO WEBHOOK (Altamente Recomendado para Segurança) ---
    // Você DEVE consultar a documentação da Wegate para saber o NOME do cabeçalho
    // que contém a assinatura e o MÉTODO EXATO de validação (ex: HMAC SHA256 do payload).
    const signatureHeader = req.headers['x-wegate-signature']; // O nome exato do cabeçalho varia!

    if (!WEGATE_WEBHOOK_SECRET) {
        console.warn('Variável WEGATE_WEBHOOK_SECRET não configurada. A validação de webhook está desabilitada.');
    } else if (signatureHeader && signatureHeader !== WEGATE_WEBBOOK_SECRET) {
        console.warn('Webhook recebido com assinatura inválida! Possível tentativa de ataque.');
        return res.status(403).send('Forbidden: Invalid signature.');
    } else if (!signatureHeader && WEGATE_WEBHOOK_SECRET) {
        console.warn('Webhook recebido sem assinatura, mas WEGATE_WEBHOOK_SECRET está configurado. Validação parcial.');
    }

    if (data.event === 'pix.payment.confirmed' && data.status === 'completed') {
        const referenceId = data.reference_id;
        const telegramId = parseInt(referenceId.split('-')[0]);
        const amount = parseFloat(data.amount);

        if (!isNaN(telegramId) && !isNaN(amount) && amount > 0) {
            try {
                const user = await User.findByPk(telegramId);
                if (user) {
                    await user.increment('balance', { by: amount });
                    await Transaction.create({
                        userId: telegramId,
                        amount: amount,
                        type: 'deposit',
                        description: `Depósito PIX confirmado (Ref: ${referenceId})`
                    });
                    console.log(`PIX confirmado para usuário ${telegramId}. Saldo atualizado para: ${user.balance + amount}`);
                } else {
                    console.warn(`Usuário ${telegramId} não encontrado no DB para confirmação de PIX (Ref: ${referenceId}).`);
                }
                res.status(200).send('Webhook recebido e processado.');
            } catch (error) {
                console.error('Erro ao processar atualização do saldo via webhook:', error);
                res.status(500).send('Erro interno do servidor ao processar webhook.');
            }
        } else {
            console.warn('Dados inválidos ou incompletos no webhook da Wegate:', data);
            res.status(400).send('Dados inválidos no webhook.');
        }
    } else {
        res.status(200).send('Evento não relevante ou status não final.');
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR WEBHOOK ---
const PORT = process.env.PORT || 8080; 

app.listen(PORT, '0.0.0.0', () => { 
  console.log(`Servidor de webhook rodando na porta ${PORT}`);
});