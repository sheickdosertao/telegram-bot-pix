// webhook.js
const express = require('express');
const bodyParser = require('body-parser');
const { Sequelize, DataTypes } = require('sequelize');
// Opcional: Para validação de hash da assinatura, se a Wegate usar
// const crypto = require('crypto'); 

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
// ATENÇÃO: force: true APAGA TODAS AS TABELAS A CADA INICIALIZAÇÃO.
// USE APENAS EM AMBIENTE DE DESENVOLVIMENTO!
sequelize.sync({ force: true }) 
    .then(() => console.log('Banco de dados PostgreSQL sincronizado (webhook)!'))
    .catch(err => {
        console.error('Erro ao sincronizar o banco de dados PostgreSQL no webhook:', err);
    });

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
    } else if (signatureHeader && signatureHeader !== WEGATE_WEBHOOK_SECRET) {
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