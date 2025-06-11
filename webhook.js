// webhook.js
const express = require('express');
const bodyParser = require('body-parser');
const { Sequelize, DataTypes } = require('sequelize'); // Importa Sequelize e DataTypes
// Opcional: Para validação de hash da assinatura, se a Wegate usar
// const crypto = require('crypto');

// --- Variáveis de Configuração (Lidas de Variáveis de Ambiente) ---
require('dotenv').config(); // Carrega as variáveis de ambiente
const DATABASE_URL = process.env.DATABASE_URL;
// Agora WEGATE_WEBHOOK_SECRET é usada
const WEGATE_WEBHOOK_SECRET = process.env.WEGATE_WEBHOOK_SECRET;

const app = express();
const port = process.env.PORT || 3000; // A porta que o Railway vai expor

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
        type: DataTypes.ENUM('deposit', 'purchase', 'refund'),
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

// --- Sincronização do Banco de Dados ---
sequelize.sync()
    .then(() => console.log('Banco de dados PostgreSQL sincronizado (webhook)!'))
    .catch(err => {
        console.error('Erro ao sincronizar o banco de dados PostgreSQL no webhook:', err);
    });

// Endpoint para receber notificações da Wegate
// IMPORTANTE: Use bodyParser.json() ANTES do middleware de validação se você precisar do raw body.
// Ou, se a validação for simples de header, pode ser como está.
app.post('/webhook/wegate-pix', bodyParser.json(), async (req, res) => {
    const data = req.body;
    console.log('Webhook da Wegate recebido:', data);

    // --- VALIDAÇÃO DO WEBHOOK (Altamente Recomendado para Segurança) ---
    // Você deve consultar a documentação da Wegate para saber o NOME do cabeçalho
    // e o MÉTODO de validação (ex: X-Wegate-Signature, X-Hub-Signature, etc.)
    // Exemplo comum:
    // const signature = req.headers['x-wegate-signature']; // O nome do cabeçalho varia!

    // if (!signature || !WEGATE_WEBHOOK_SECRET) {
    //     console.warn('Webhook recebido sem assinatura ou secret configurado.');
    //     return res.status(403).send('Forbidden: Missing signature or secret.');
    // }

    // Exemplo de validação SIMPLES (se a Wegate enviar o secret direto no header):
    // if (signature !== WEGATE_WEBHOOK_SECRET) {
    //     console.warn('Webhook com assinatura inválida!');
    //     return res.status(403).send('Forbidden: Invalid signature.');
    // }

    // Exemplo de validação com HASH (se a Wegate assinar o payload) - MAIS SEGURO:
    // const hmac = crypto.createHmac('sha256', WEGATE_WEBHOOK_SECRET);
    // hmac.update(JSON.stringify(data)); // ou req.rawBody se precisar do corpo puro
    // const digest = 'sha256=' + hmac.digest('hex');
    // if (digest !== signature) {
    //    console.warn('Webhook com assinatura inválida!');
    //    return res.status(403).send('Forbidden: Invalid signature.');
    // }


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

app.listen(port, () => {
    console.log(`Servidor de webhook rodando na porta ${port}`);
});