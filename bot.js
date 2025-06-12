// bot.js
// --- Importações de Módulos ---
require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env
const TelegramBot = require('node-telegram-bot-api');
const { Sequelize, DataTypes } = require('sequelize'); // Importa Sequelize e DataTypes
const axios = require('axios'); // Para fazer requisições HTTP (API da Wegate)
const qrcode = require('qrcode'); // Para gerar QR Codes

// --- Variáveis de Configuração (Lidas de Variáveis de Ambiente) ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL; // URL de conexão do PostgreSQL
const WEGATE_API_KEY = process.env.WEGATE_API_KEY;
const WEGATE_PIX_API_URL = process.env.WEGATE_PIX_API_URL;
const MY_PIX_KEY = process.env.MY_PIX_KEY;

// Verifica se as variáveis essenciais estão definidas
if (!TELEGRAM_BOT_TOKEN || !DATABASE_URL || !WEGATE_API_KEY || !WEGATE_PIX_API_URL || !MY_PIX_KEY) {
    console.error('ERRO: Por favor, configure todas as variáveis de ambiente no arquivo .env ou no ambiente de deploy.');
    process.exit(1);
}

// --- Inicialização do Bot ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
console.log('Bot Telegram iniciado e aguardando mensagens...');

// --- Conexão PostgreSQL com Sequelize ---
const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: false, // Desabilita logs de SQL no console (true para depuração)
    dialectOptions: {
        ssl: process.env.NODE_ENV === 'production' ? {
            require: true,
            rejectUnauthorized: false // Para Railway e outros hosts que usam SSL auto-assinado
        } : false
    }
});

// --- Definição dos Modelos ---

const User = sequelize.define('User', {
    telegramId: {
        type: DataTypes.BIGINT, // Use BIGINT para IDs do Telegram
        allowNull: false,
        unique: true,
        primaryKey: true // Define telegramId como chave primária
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
        defaultValue: false // Por padrão, ninguém é admin
    }
}, {
    timestamps: false // Não crie colunas createdAt/updatedAt para o User
});

const Transaction = sequelize.define('Transaction', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    type: {
        type: DataTypes.ENUM('deposit', 'purchase', 'refund'), // Tipo da transação
        allowNull: false
    },
    amount: {
        type: DataTypes.FLOAT, // Valor da transação
        allowNull: false
    },
    description: {
        type: DataTypes.STRING
    },
    timestamp: {
        type: DataTypes.DATE, // Data e hora da transação
        defaultValue: DataTypes.NOW
    }
});

// --- Relação entre Modelos ---
User.hasMany(Transaction, { foreignKey: 'userId', onDelete: 'CASCADE' }); // Um usuário tem muitas transações
Transaction.belongsTo(User, { foreignKey: 'userId' }); // Uma transação pertence a um usuário

// --- Sincronização do Banco de Dados ---
// ATENÇÃO: force: true APAGA TODAS AS TABELAS A CADA INICIALIZAÇÃO.
// USE APENAS EM AMBIENTE DE DESENVOLVIMENTO!
sequelize.sync({ force: true }) 
    .then(() => console.log('Banco de dados PostgreSQL sincronizado (tabelas criadas/atualizadas)!'))
    .catch(err => {
        console.error('Erro ao sincronizar o banco de dados PostgreSQL:', err);
        process.exit(1);
    });

// --- Funções de Ajuda do Banco de Dados ---

/**
 * Encontra um usuário ou o cria se não existir.
 * @param {number} telegramId - ID do Telegram do usuário.
 * @param {string} username - Nome de usuário do Telegram.
 * @returns {Promise<Model>} O modelo do usuário.
 */
async function findOrCreateUser(telegramId, username) {
    const [user, created] = await User.findOrCreate({
        where: { telegramId },
        defaults: { username }
    });
    if (created) {
        console.log(`Novo usuário registrado: ${username} (${telegramId})`);
    } else {
        console.log(`Usuário existente encontrado: ${username} (${telegramId})`);
    }
    return user;
}

/**
 * Atualiza o saldo do usuário e registra uma transação.
 * @param {number} telegramId - ID do Telegram do usuário.
 * @param {number} amount - Valor a ser adicionado (positivo) ou subtraído (negativo).
 * @param {string} type - Tipo da transação ('deposit', 'purchase', 'refund').
 * @param {string} description - Descrição da transação.
 * @returns {Promise<Model>} O modelo do usuário atualizado.
 */
async function updateUserBalance(telegramId, amount, type, description = '') {
    const user = await User.findByPk(telegramId);
    if (user) {
        await user.increment('balance', { by: amount });
        await Transaction.create({
            userId: telegramId,
            amount,
            type,
            description
        });
        await user.reload(); // Recarrega o usuário para ter o saldo atualizado
        console.log(`Saldo de ${user.username} (${telegramId}) atualizado em ${amount}. Novo saldo: ${user.balance}`);
    }
    return user;
}

// --- Comandos do Bot ---

// Comando /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'Usuário';

    const user = await findOrCreateUser(telegramId, username);
    bot.sendMessage(chatId, `Olá, ${username}! Bem-vindo ao bot de GGs e cartões de teste. Seu saldo atual é: R$ ${user.balance.toFixed(2)}.`);
});

// Comando /registrar
bot.onText(/\/registrar/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'Usuário';

    const user = await User.findByPk(telegramId); // findOrCreateUser já lida com a criação
    if (user) {
        bot.sendMessage(chatId, 'Você já está registrado!');
    } else {
        await findOrCreateUser(telegramId, username);
        bot.sendMessage(chatId, 'Você foi registrado com sucesso! Seu saldo inicial é R$ 0.00.');
    }
});

// Comando /saldo
bot.onText(/\/saldo/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    const user = await User.findByPk(telegramId);
    if (user) {
        bot.sendMessage(chatId, `Seu saldo atual: R$ ${user.balance.toFixed(2)}`);
    } else {
        bot.sendMessage(chatId, 'Você ainda não está registrado. Use /registrar para criar uma conta.');
    }
});

// Comando /depositar <valor>
bot.onText(/\/depositar (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const amount = parseFloat(match[1]);

    if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, 'Por favor, informe um valor positivo para depósito. Ex: /depositar 10');
    }

    const user = await User.findByPk(telegramId);
    if (!user) {
        return bot.sendMessage(chatId, 'Você ainda não está registrado. Use /registrar para criar uma conta antes de depositar.');
    }

    try {
        const pixPayload = {
            value: amount.toFixed(2),
            description: `Depósito para o usuário ${msg.from.username || telegramId}`,
            reference_id: `${telegramId}-${Date.now()}`,
        };

        const wegateResponse = await axios.post(`${WEGATE_PIX_API_URL}/generate`, pixPayload, {
            headers: {
                'Authorization': `Bearer ${WEGATE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const pixData = wegateResponse.data.qrcode_data || wegateResponse.data.qr_code_image_base64_data;
        const pixCopyPasteCode = wegateResponse.data.pix_code;

        let imageBuffer;
        if (pixData.startsWith('data:image')) {
            imageBuffer = Buffer.from(pixData.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        } else {
            const qrCodeImageBase64 = await qrcode.toDataURL(pixData);
            imageBuffer = Buffer.from(qrCodeImageBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        }
        
        bot.sendPhoto(chatId, imageBuffer, {
            caption: `Para depositar R$ ${amount.toFixed(2)}, faça um PIX para a chave ou o QR Code abaixo:\n\n` +
                     `**Sua Chave PIX:** \`${MY_PIX_KEY}\`\n\n` +
                     `**Código PIX Copia e Cola:**\n\`${pixCopyPasteCode}\`\n\n` +
                     `*Importante: O saldo será creditado automaticamente após a confirmação do pagamento pela Wegate.*`
        }, { contentType: 'image/png' });

    } catch (error) {
        console.error('Erro ao gerar PIX ou enviar QR Code:', error.message || error);
        if (error.response) {
            console.error('Dados do erro da API Wegate:', error.response.data);
        }
        bot.sendMessage(chatId, 'Ocorreu um erro ao processar seu depósito. Por favor, tente novamente mais tarde ou entre em contato com o suporte.');
    }
});

// Comando /comprar <tipo> <quantidade>
bot.onText(/\/comprar (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const itemType = match[1].toLowerCase();
    const quantity = parseInt(match[2]);

    if (isNaN(quantity) || quantity <= 0) {
        return bot.sendMessage(chatId, 'Quantidade inválida. Use um número positivo. Ex: /comprar gg 1');
    }

    const user = await User.findByPk(telegramId);
    if (!user) {
        return bot.sendMessage(chatId, 'Você ainda não está registrado. Use /registrar para criar uma conta.');
    }

    let pricePerItem = 0;
    let generateFunction;
    let itemDescription = '';

    switch (itemType) {
        case 'gg':
            pricePerItem = 5.0; // Preço por GG
            generateFunction = generateGG;
            itemDescription = 'GG';
            break;
        case 'card':
        case 'cartao':
            pricePerItem = 10.0; // Preço por cartão de teste
            generateFunction = generateTestCreditCardData;
            itemDescription = 'cartão de teste';
            break;
        default:
            return bot.sendMessage(chatId, 'Tipo de item inválido. Escolha "gg" ou "card".');
    }

    const totalCost = quantity * pricePerItem;

    // --- MODIFICAÇÃO TEMPORÁRIA PARA TESTE: DESABILITA VERIFICAÇÃO DE SALDO ---
    if (false && user.balance < totalCost) { // 'if (false && ...)' sempre será falso, desativando a checagem
        return bot.sendMessage(chatId, `Saldo insuficiente! Você precisa de R$ ${totalCost.toFixed(2)}, mas tem apenas R$ ${user.balance.toFixed(2)}.`);
    }
    // FIM DA MODIFICAÇÃO TEMPORÁRIA
    
    const updatedUser = await updateUserBalance(telegramId, -totalCost, 'purchase', `Compra de ${quantity} ${itemDescription}(s)`);

    let generatedItems = [];
    for (let i = 0; i < quantity; i++) {
        generatedItems.push(generateFunction());
    }

    bot.sendMessage(chatId,
        `Compra de ${quantity} ${itemDescription}(s) realizada com sucesso! Saldo restante: R$ ${updatedUser.balance.toFixed(2)}.\n\n` +
        `Seus ${itemDescription}(s):\n\`\`\`\n${generatedItems.join('\n')}\n\`\`\``,
        { parse_mode: 'Markdown' }
    );
});

// Comando de Administrador: /setsaldo <telegramId> <valor>
bot.onText(/\/setsaldo (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminTelegramId = msg.from.id;
    const targetTelegramId = parseInt(match[1]); // ID do usuário a ser modificado
    const amount = parseFloat(match[2]); // Valor a ser adicionado/removido

    // 1. Verificar se o usuário que emitiu o comando é um admin
    const adminUser = await User.findByPk(adminTelegramId);
    if (!adminUser || !adminUser.isAdmin) {
        return bot.sendMessage(chatId, 'Acesso negado. Você não tem permissão de administrador para usar este comando.');
    }

    // 2. Validar o valor
    if (isNaN(targetTelegramId) || isNaN(amount)) {
        return bot.sendMessage(chatId, 'Uso: /setsaldo <ID_do_usuário> <valor>. Ex: /setsaldo 123456789 100');
    }

    // 3. Encontrar o usuário alvo
    const targetUser = await User.findByPk(targetTelegramId);
    if (!targetUser) {
        return bot.sendMessage(chatId, `Usuário com ID ${targetTelegramId} não encontrado.`);
    }

    // 4. Atualizar o saldo (usando a função updateUserBalance existente)
    try {
        const updatedUser = await updateUserBalance(targetTelegramId, amount, 'admin_adjustment', `Ajuste de saldo por admin ${adminTelegramId}`);
        // LINHA CORRIGIDA: Usa template literals ` ` para a string
        bot.sendMessage(chatId, `Saldo de ${updatedUser.username} (${updatedUser.telegramId}) ajustado. Novo saldo: R$ ${updatedUser.balance.toFixed(2)}.`);
    } catch (error) {
        console.error('Erro ao ajustar saldo por admin:', error);
        bot.sendMessage(chatId, 'Ocorreu um erro ao ajustar o saldo.');
    }
});


// --- Funções de Geração (GGs e Cartões de Teste) ---

/**
 * Gera uma 'GG' no formato NNNNNNNNNNNNNNNN|NN|NNNN|NNN.
 * Assumindo que cada segmento é uma sequência de dígitos aleatórios.
 * @returns {string} A GG gerada.
 */
function generateGG() {
    const segment1 = Math.floor(Math.random() * 10**16).toString().padStart(16, '0'); // 16 dígitos
    const segment2 = Math.floor(Math.random() * 10**2).toString().padStart(2, '0');   // 2 dígitos
    const segment3 = Math.floor(Math.random() * 10**4).toString().padStart(4, '0');   // 4 dígitos
    const segment4 = Math.floor(Math.random() * 10**3).toString().padStart(3, '0');   // 3 dígitos
    return `${segment1}|${segment2}|${segment3}|${segment4}`;
}


/**
 * Gera dados de cartão de crédito para TESTE (NÃO SÃO CARTÕES REAIS).
 * IMPORTANTE: Estes dados são para TESTE em ambientes de DESENVOLVIMENTO/SANDBOX.
 * NUNCA USE PARA TRANSAÇÕES REAIS.
 * Baseado em padrões de cartões de teste e algoritmo de Luhn.
 * @returns {string} Uma string formatada com os dados do cartão de teste.
 */
function generateTestCreditCardData() {
    const cardTypes = {
        'Visa': '4',
        'MasterCard': '5',
        'Amex': '34,37',
        'Discover': '6011'
    };

    const typeNames = Object.keys(cardTypes);
    const randomTypeName = typeNames[Math.floor(Math.random() * typeNames.length)];
    let prefix = cardTypes[randomTypeName];

    if (randomTypeName === 'Amex') {
        prefix = prefix.split(',')[Math.floor(Math.random() * prefix.split(',').length)]; // Escolhe entre 34 ou 37
    }

    const length = randomTypeName === 'Amex' ? 15 : 16;

    // Implementação do Algoritmo de Luhn para gerar um número válido para testes
    function generateLuhnNumber(basePrefix, len) {
        let cardNumber = basePrefix;
        while (cardNumber.length < len - 1) {
            cardNumber += Math.floor(Math.random() * 10);
        }

        let sum = 0;
        let parity = cardNumber.length % 2; // Paridade do tamanho da string base

        for (let i = 0; i < cardNumber.length; i++) {
            let digit = parseInt(cardNumber[i]);
            if (i % 2 === parity) {
                digit *= 2;
                if (digit > 9) {
                    digit -= 9;
                }
            }
            sum += digit;
        }

        const checkDigit = (10 - (sum % 10)) % 10;
        return cardNumber + checkDigit;
    }

    const testCardNumber = generateLuhnNumber(prefix, length);

    // Data de validade futura
    const currentYear = new Date().getFullYear();
    const expYear = currentYear + Math.floor(Math.random() * 5) + 1; // 1 a 5 anos no futuro
    const expMonth = Math.floor(Math.random() * 12) + 1; // 1 a 12

    // CVV (3 ou 4 dígitos)
    const cvv = randomTypeName === 'Amex' ? Math.floor(1000 + Math.random() * 9000) : Math.floor(100 + Math.random() * 900);

    return `Tipo: ${randomTypeName}, Número: ${testCardNumber}, Validade: ${String(expMonth).padStart(2, '0')}/${expYear}, CVV: ${cvv} (APENAS PARA TESTES - NÃO É UM CARTÃO REAL)`;
}

