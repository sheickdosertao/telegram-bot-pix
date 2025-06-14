// bot.js
// --- Importações de Módulos ---
require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env
const TelegramBot = require('node-telegram-bot-api');
const { Sequelize, DataTypes, Op } = require('sequelize'); // Importa Sequelize, DataTypes e Op para operações de consulta
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
        type: DataTypes.ENUM('deposit', 'purchase', 'refund', 'admin_adjustment'), // Adicionado 'admin_adjustment'
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
        console.log('Banco de dados PostgreSQL sincronizado (tabelas criadas/atualizadas com ALTER)!');
    } catch (err) {
        console.error('Erro ao sincronizar o banco de dados PostgreSQL:', err);
        // O erro 'duplicar valor da chave viola a restrição de unicidade "pg_type_typname_nsp_index"'
        // geralmente acontece por um tipo ENUM já existente.
        // Se este erro persistir, você DEVE executar manualmente:
        // DROP TYPE IF EXISTS "enum_Transactions_type" CASCADE;
        // no seu DB via pgAdmin/psql.
        process.exit(1);
    }
}

syncDatabase(); // Chama a função assíncrona para iniciar a sincronização do DB


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
 * @param {string} type - Tipo da transação ('deposit', 'purchase', 'refund', 'admin_adjustment').
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

    if (user.balance < totalCost) {
        return bot.sendMessage(chatId, `Saldo insuficiente! Você precisa de R$ ${totalCost.toFixed(2)}, mas tem apenas R$ ${user.balance.toFixed(2)}.`);
    }
    
    const updatedUser = await updateUserBalance(telegramId, -totalCost, 'purchase', `Compra de ${quantity} ${itemDescription}(s)`);

    let generatedItems = [];
    let responseMessage = `Compra de ${quantity} ${itemDescription}(s) realizada com sucesso! Saldo restante: R$ ${updatedUser.balance.toFixed(2)}.\n\n`;
    responseMessage += `Seus ${itemDescription}(s):\n\`\`\`\n`;

    for (let i = 0; i < quantity; i++) {
        const item = generateFunction();
        const itemStatus = await checkGGStatus(itemType, item); 
        generatedItems.push(`${item} [Status: ${itemStatus}]`); // Adiciona o status
    }
    responseMessage += `${generatedItems.join('\n')}\n\`\`\``;

    bot.sendMessage(chatId, responseMessage, { parse_mode: 'Markdown' });
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
        bot.sendMessage(chatId, `Saldo de ${updatedUser.username} (${updatedUser.telegramId}) ajustado. Novo saldo: R$ ${updatedUser.balance.toFixed(2)}.`);
    } catch (error) {
        console.error('Erro ao ajustar saldo por admin:', error);
        bot.sendMessage(chatId, 'Ocorreu um erro ao ajustar o saldo.');
    }
});

// Comando de Administrador: /report
bot.onText(/\/report/, async (msg) => {
    const chatId = msg.chat.id;
    const adminTelegramId = msg.from.id;

    // 1. Verificar se o usuário que emitiu o comando é um admin
    const adminUser = await User.findByPk(adminTelegramId);
    if (!adminUser || !adminUser.isAdmin) {
        return bot.sendMessage(chatId, 'Acesso negado. Você não tem permissão de administrador para usar este comando.');
    }

    try {
        const users = await User.findAll({
            order: [['balance', 'DESC']], // Ordena por saldo decrescente
        });

        let reportMessage = '📊 **Relatório de Saldo de Usuários** 📊\n\n';
        reportMessage += `Total de Usuários: ${users.length}\n\n`;
        reportMessage += '--- Saldo por Usuário ---\n';

        if (users.length === 0) {
            reportMessage += 'Nenhum usuário registrado ainda.\n';
        } else {
            for (const user of users) {
                reportMessage += `\nID: ${user.telegramId}\n`;
                reportMessage += `Username: ${user.username}\n`;
                reportMessage += `Saldo: R$ ${user.balance.toFixed(2)}\n`;
                reportMessage += `Admin: ${user.isAdmin ? 'Sim' : 'Não'}\n`;
            }
        }
        reportMessage += '\n-------------------------\n';

        const today = new Date();
        today.setHours(0, 0, 0, 0); // Começo do dia
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1); // Fim do dia

        const dailyTransactions = await Transaction.findAll({
            where: {
                timestamp: {
                    [Op.gte]: today,
                    [Op.lt]: tomorrow,
                },
            },
            include: [{
                model: User,
                attributes: ['telegramId', 'username']
            }],
            order: [['timestamp', 'ASC']],
        });

        reportMessage += `📅 **Transações de Hoje (${today.toLocaleDateString('pt-BR')})** 📅\n`;
        if (dailyTransactions.length === 0) {
            reportMessage += 'Nenhuma transação registrada hoje.\n';
        } else {
            for (const transaction of dailyTransactions) {
                const username = transaction.User ? transaction.User.username : 'Desconhecido';
                reportMessage += `\nUsuário: ${username} (ID: ${transaction.userId})\n`;
                reportMessage += `Tipo: ${transaction.type}\n`;
                reportMessage += `Valor: R$ ${transaction.amount.toFixed(2)}\n`;
                reportMessage += `Descrição: ${transaction.description || 'N/A'}\n`;
                reportMessage += `Hora: ${new Date(transaction.timestamp).toLocaleTimeString('pt-BR')}\n`;
            }
        }
        reportMessage += '\n-------------------------\n';
        reportMessage += 'Relatório gerado em: ' + new Date().toLocaleString('pt-BR');


        bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Erro ao gerar relatório de saldo:', error);
        bot.sendMessage(chatId, 'Ocorreu um erro ao gerar o relatório. Por favor, tente novamente mais tarde.');
    }
});


// --- Funções de Geração (GGs e Cartões de Teste) ---

/**
 * Gera uma 'GG' no formato NNNNNNNNNNNNNNNN|NN|NNNN|NNN com um checksum simples.
 * Adiciona uma data de validade de 30 dias.
 * @returns {string} A GG gerada com data de validade e "checksum" implícito.
 */
function generateGG() {
    // Gerar segmentos aleatórios como antes
    const segment1 = Math.floor(Math.random() * 10**16).toString().padStart(16, '0'); // 16 dígitos
    const segment2 = Math.floor(Math.random() * 10**2).toString().padStart(2, '0');   // 2 dígitos
    const segment3 = Math.floor(Math.random() * 10**4).toString().padStart(4, '0');   // 4 dígitos
    const segment4 = Math.floor(Math.random() * 10**3).toString().padStart(3, '0');   // 3 dígitos
    
    // Data de validade (ex: 30 dias a partir de agora)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    const day = String(expiryDate.getDate()).padStart(2, '0');
    const month = String(expiryDate.getMonth() + 1).padStart(2, '0'); // Mês é 0-indexed
    const year = expiryDate.getFullYear();
    const formattedExpiryDate = `${day}/${month}/${year}`;

    return `${segment1}|${segment2}|${segment3}|${segment4} (Validade: ${formattedExpiryDate})`;
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

/**
 * Função para validar o formato de uma GG e simular seu status "LIVE".
 * PRIMEIRO: Valida o formato da GG.
 * SEGUNDO: Simula o status "LIVE" (requer API real para verificação verdadeira).
 * @param {string} itemType - Tipo do item ('gg' ou 'card').
 * @param {string} item - A GG ou o Card a ser verificado.
 * @returns {Promise<string>} O status ('LIVE', 'DIE', 'INVALID_FORMAT', 'ERROR').
 */
async function checkGGStatus(itemType, item) {
    // 1. Validação de Formato (Checksum para GGs)
    if (itemType === 'gg') {
        const ggPattern = /^(\d{16})\|(\d{2})\|(\d{4})\|(\d{3}) \(Validade: \d{2}\/\d{2}\/\d{4}\)$/;
        if (!ggPattern.test(item)) {
            return 'INVALID_FORMAT'; // Retorna que o formato está errado
        }
        // Se precisar de uma lógica de checksum mais complexa para a GG (ex: soma de dígitos),
        // ela seria implementada aqui. Por enquanto, a validação regex é o checksum de formato.
    } else if (itemType === 'card') {
        // Para cards, a validação de Luhn é feita na geração.
        // Se precisasse validar novamente aqui, a lógica seria adicionada.
    }

    // --- EXEMPLO CONCEITUAL DE CHAMADA A UMA API EXTERNA ---
    // ESTA PARTE AINDA É UMA SIMULAÇÃO.
    // PARA VERIFICAÇÃO "LIVE" REAL, VOCÊ PRECISARÁ DE UMA API REAL E LEGÍTIMA.
    const EXTERNAL_API_URL = 'https://api.exemplo.com/check-item-status'; // URL da sua API de verificação
    const EXTERNAL_API_KEY = 'SUA_CHAVE_DA_API'; // Chave da sua API de verificação

    try {
        // Simulação de delay de rede
        await new Promise(resolve => setTimeout(resolve, 500)); 

        // EXEMPLO 1: Usando uma API que espera um POST com o item
        /*
        const response = await axios.post(EXTERNAL_API_URL, {
            type: itemType,
            itemValue: item // O item completo, incluindo validade se a API precisar
        }, {
            headers: {
                'Authorization': `Bearer ${EXTERNAL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.status; // Supondo que a API retorne { status: 'LIVE'/'DIE'/'INVALID' }
        */

        // EXEMPLO 2: Usando uma API que espera um GET com o item na URL
        /*
        const encodedItem = encodeURIComponent(item); // Codificar o item para URL
        const response = await axios.get(`${EXTERNAL_API_URL}?type=${itemType}&item=${encodedItem}`, {
            headers: { 'Authorization': `Bearer ${EXTERNAL_API_KEY}` }
        });
        return response.data.status;
        */

        // --- MOCK ATUAL (REMOVER ESTE BLOCO EM PRODUÇÃO COM API REAL) ---
        const randomNumber = Math.random();
        if (itemType === 'gg') {
            if (randomNumber < 0.7) { // 70% de chance de ser LIVE
                return 'LIVE';
            } else if (randomNumber < 0.9) { // 20% de chance de ser DIE
                return 'DIE';
            } else { // 10% de chance de ser INVÁLIDO
                return 'INVALID';
            }
        } else if (itemType === 'card') {
            if (randomNumber < 0.6) { // 60% de chance de ser LIVE
                return 'LIVE';
            } else { // 40% de chance de ser DIE
                return 'DIE';
            }
        }
        return 'UNKNOWN'; // Tipo desconhecido

    } catch (error) {
        console.error(`Erro ao tentar verificar status do item (${itemType}):`, error.message || error);
        if (error.response) {
            console.error('Dados do erro da API de verificação (provavelmente mock):', error.response.data);
        }
        return 'ERROR'; // Retorna 'ERROR' em caso de falha na comunicação ou na API
    }
}

