// bot.js
// --- Importações de Módulos ---
require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env
const TelegramBot = require('node-telegram-bot-api');
const { Sequelize, DataTypes } = require('sequelize'); // Importa Sequelize, DataTypes e Op para operações de consulta
const axios = require('axios'); // Para fazer requisições HTTP (API da Wegate e PagSeguro)
const qrcode = require('qrcode'); // Para gerar QR Codes

// --- Variáveis de Configuração (Lidas de Variáveis de Ambiente) ---
const PAGBANK_API_TOKEN = process.env.PAGBANK_API_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL; // URL de conexão do PostgreSQL


const PAGBANK_API_URL = 'https://api.pagseguro.com/orders'; // URL da API do PagSeguro


// Verifica se as variáveis essenciais estão definidas
if (!TELEGRAM_BOT_TOKEN || !DATABASE_URL || !PAGBANK_API_TOKEN) {
    console.error('ERRO: Por favor, configure todas as variáveis de ambiente essenciais no arquivo .env ou no ambiente de deploy.');
    console.error('Variáveis obrigatórias: TELEGRAM_BOT_TOKEN, DATABASE_URL, PAGBANK_API_TOKEN');
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
    },
    paymentId: { // Novo campo para armazenar ID do pagamento (PagSeguro ou Wegate)
        type: DataTypes.STRING,
        allowNull: true
    },
    paymentMethod: { // Novo campo para identificar método de pagamento
        type: DataTypes.ENUM('pix_wegate', 'pix_pagseguro', 'credit_card', 'boleto'),
        allowNull: true
    }
});

// --- Relação entre Modelos ---
User.hasMany(Transaction, { foreignKey: 'userId', onDelete: 'CASCADE' }); // Um usuário tem muitas transações
Transaction.belongsTo(User, { foreignKey: 'userId' }); // Uma transação pertence a um usuário

/**
 * Função para garantir que o tipo ENUM existe e contém todos os valores necessários.
 */
async function ensureEnumTypes() {
    try {
        // Verifica e adiciona valores ao ENUM de Transaction type
        const [transactionResults] = await sequelize.query(`
            SELECT enumlabel
            FROM pg_enum
            WHERE enumtypid = (
                SELECT oid FROM pg_type WHERE typname = 'enum_Transactions_type'
            ) AND enumlabel = 'admin_adjustment';
        `);

        if (transactionResults.length === 0) {
            await sequelize.query(`
                ALTER TYPE "public"."enum_Transactions_type" ADD VALUE 'admin_adjustment' AFTER 'refund';
            `);
            console.log('ENUM value "admin_adjustment" added to "enum_Transactions_type".');
        }

        // Para o ENUM de payment methods (será criado automaticamente pelo Sequelize)
        console.log('ENUM types verified/updated successfully.');
    } catch (error) {
        console.warn('Não foi possível verificar/alterar os tipos ENUM:', error.message);
    }
}

// --- Sincronização do Banco de Dados ---
async function syncDatabase() {
    try {
        await ensureEnumTypes();
        await sequelize.sync({ alter: true }); 
        console.log('Banco de dados PostgreSQL sincronizado (tabelas criadas/atualizadas com ALTER)!');
    } catch (err) {
        console.error('Erro ao sincronizar o banco de dados PostgreSQL:', err);
        process.exit(1);
    }
}

syncDatabase(); // Chama a função assíncrona para iniciar a sincronização do DB

// --- Funções de Ajuda do Banco de Dados ---

/**
 * Encontra um usuário ou o cria se não existir.
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
 */
async function updateUserBalance(telegramId, amount, type, description = '', paymentId = null, paymentMethod = null) {
    const user = await User.findByPk(telegramId);
    if (user) {
        await user.increment('balance', { by: amount });
        await Transaction.create({
            userId: telegramId,
            amount,
            type,
            description,
            paymentId,
            paymentMethod
        });
        await user.reload(); // Recarrega o usuário para ter o saldo atualizado
        console.log(`Saldo de ${user.username} (${telegramId}) atualizado em ${amount}. Novo saldo: ${user.balance}`);
    }
    return user;
}

// --- Funções do PagSeguro ---

/**
 * Cria um pagamento PIX via PagSeguro
 */
async function createPagSeguroPIX(amount, telegramId, username) {
    try {
        const referenceId = `telegram-${telegramId}-${Date.now()}`;
        
        const orderData = {
            reference_id: referenceId,
            customer: {
                name: username || 'Cliente Telegram',
                email: `user${telegramId}@telegram.bot`, // Email fictício
                tax_id: "12345678909" // CPF fictício para teste
            },
            items: [{
                reference_id: "item-001",
                name: "Recarga de Saldo",
                quantity: 1,
                unit_amount: Math.round(amount * 100) // PagSeguro trabalha com centavos
            }],
            qr_codes: [{
                amount: {
                    value: Math.round(amount * 100) // Valor em centavos
                },
                expiration_date: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutos
            }],
            notification_urls: [`${process.env.WEBHOOK_URL}/webhook/pagseguro`] // URL do seu webhook
        };

        const response = await axios.post(PAGBANK_API_URL, orderData, {
            headers: {
                'Authorization': `Bearer ${PAGBANK_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        return {
            success: true,
            orderId: response.data.id,
            pixCode: response.data.qr_codes[0].text,
            qrCodeImage: response.data.qr_codes[0].links[0].href,
            referenceId
        };

    } catch (error) {
        console.error('Erro ao criar PIX PagSeguro:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.error_messages || 'Erro desconhecido'
        };
    }
}

// Função para gerar GG (Gift Cards/Códigos)
// Função para gerar GG (Gift Cards/Códigos)
function generateGG() {
    try {
        // Gera um código único no formato GG + timestamp + código aleatório
        const timestamp = Date.now().toString().slice(-6);
        const randomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const code = `GG${timestamp}${randomCode}`;
        
        return code;
    } catch (error) {
        console.error('Erro ao gerar GG:', error);
        return null;
    }
}

// Função para gerar dados de cartão de crédito para teste
function generateTestCreditCardData() {
    try {
        // Números de cartão de teste válidos (Luhn algorithm)
        const testCards = [
            '4111111111111111', // Visa
            '4000000000000002', // Visa
            '5555555555554444', // Mastercard
            '5105105105105100', // Mastercard
            '378282246310005',  // American Express
            '371449635398431',  // American Express
            '6011111111111117', // Discover
            '6011000990139424'  // Discover
        ];
        
        const randomCard = testCards[Math.floor(Math.random() * testCards.length)];
        const expMonth = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
        const expYear = String(2025 + Math.floor(Math.random() * 5));
        const cvv = String(Math.floor(Math.random() * 900) + 100);
        
        return `${randomCard}|${expMonth}|${expYear}|${cvv}`;
    } catch (error) {
        console.error('Erro ao gerar cartão de teste:', error);
        return null;
    }
}

// Função para verificar o status de GG/Cards
async function checkGGStatus(itemType, item) {
    try {
        if (!item) return 'ERRO';
        
        switch (itemType) {
            case 'gg': {
                // Simula verificação de status do GG
                const ggStatuses = ['LIVE', 'DIE', 'UNKNOWN'];
                return ggStatuses[Math.floor(Math.random() * ggStatuses.length)];
            }
                
            case 'card':
            case 'cartao': {
                // Simula verificação de status do cartão
                const cardStatuses = ['LIVE', 'DIE', 'UNKNOWN'];
                return cardStatuses[Math.floor(Math.random() * cardStatuses.length)];
            }
                
            default:
                return 'UNKNOWN';
        }
    } catch (error) {
        console.error('Erro ao verificar status:', error);
        return 'ERRO';
    }
}

// Comando de compra principal
bot.onText(/\/comprar (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const itemType = match[1].toLowerCase();
    const quantity = parseInt(match[2]);

    if (isNaN(quantity) || quantity <= 0) {
        return bot.sendMessage(chatId, '❌ Quantidade inválida. Use um número positivo.\n📝 Ex: /comprar gg 1');
    }

    if (quantity > 50) {
        return bot.sendMessage(chatId, '❌ Quantidade máxima por compra: 50 itens');
    }

    const user = await User.findByPk(telegramId);
    if (!user) {
        return bot.sendMessage(chatId, 'Você ainda não está registrado. Use /start para criar uma conta.');
    }

    let pricePerItem = 0;
    let generateFunction;
    let itemDescription = '';

    switch (itemType) {
        case 'gg': {
            pricePerItem = 10.0;
            generateFunction = generateGG;
            itemDescription = 'GG';
            break;
        }
        case 'card':
        case 'cartao': {
            pricePerItem = 5.0;
            generateFunction = generateTestCreditCardData;
            itemDescription = 'cartão de teste';
            break;
        }
        default:
            return bot.sendMessage(chatId, '❌ Tipo de item inválido.\n✅ Escolha "gg" ou "card".\n\n📖 Exemplos:\n/comprar gg 5\n/comprar card 10');
    }

    const totalCost = quantity * pricePerItem;

    if (user.balance < totalCost) {
        return bot.sendMessage(chatId, `❌ Saldo insuficiente!\n💰 Necessário: R$ ${totalCost.toFixed(2)}\n💳 Seu saldo: R$ ${user.balance.toFixed(2)}\n\n💡 Use /depositar para recarregar.`);
    }

    try {
        // Processa o pagamento
        bot.sendMessage(chatId, '⏳ Processando compra...');

        const updatedUser = await updateUserBalance(telegramId, -totalCost, 'purchase', 
            `Compra de ${quantity} ${itemDescription}(s)`, null, 'purchase');

        let generatedItems = [];
        let liveCount = 0;
        let dieCount = 0;
        let unknownCount = 0;

        // Gera os itens
        for (let i = 0; i < quantity; i++) {
            const item = generateFunction();
            if (item) {
                const itemStatus = await checkGGStatus(itemType, item);
                generatedItems.push(`${item} [${itemStatus}]`);
                
                // Conta estatísticas
                switch (itemStatus) {
                    case 'LIVE': liveCount++; break;
                    case 'DIE': dieCount++; break;
                    default: unknownCount++; break;
                }
            } else {
                generatedItems.push('ERRO NA GERAÇÃO');
            }
        }

        // Monta a mensagem de resposta
        let responseMessage = `✅ Compra realizada com sucesso!\n`;
        responseMessage += `💰 Saldo restante: R$ ${updatedUser.balance.toFixed(2)}\n`;
        responseMessage += `📊 Estatísticas: 🟢${liveCount} | 🔴${dieCount} | ⚪${unknownCount}\n\n`;
        responseMessage += `🎯 Seus ${itemDescription}(s):\n\`\`\`\n`;
        responseMessage += `${generatedItems.join('\n')}\n\`\`\``;

        // Divide mensagem se for muito longa
        if (responseMessage.length > 4000) {
            // Envia estatísticas primeiro
            const statsMessage = `✅ Compra realizada com sucesso!\n💰 Saldo restante: R$ ${updatedUser.balance.toFixed(2)}\n📊 Estatísticas: 🟢${liveCount} | 🔴${dieCount} | ⚪${unknownCount}`;
            await bot.sendMessage(chatId, statsMessage);

            // Divide os itens em grupos
            const itemsPerMessage = 30;
            for (let i = 0; i < generatedItems.length; i += itemsPerMessage) {
                const itemsGroup = generatedItems.slice(i, i + itemsPerMessage);
                const itemsMessage = `🎯 ${itemDescription}(s) - Parte ${Math.floor(i / itemsPerMessage) + 1}:\n\`\`\`\n${itemsGroup.join('\n')}\n\`\`\``;
                await bot.sendMessage(chatId, itemsMessage, { parse_mode: 'Markdown' });
                
                // Delay entre mensagens
                if (i + itemsPerMessage < generatedItems.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        } else {
            await bot.sendMessage(chatId, responseMessage, { parse_mode: 'Markdown' });
        }

        // Log da compra
        console.log(`Compra realizada - User: ${telegramId}, Tipo: ${itemType}, Quantidade: ${quantity}, Valor: R$ ${totalCost}`);

    } catch (error) {
        console.error('Erro no processamento da compra:', error);
        
        // Reverte o saldo em caso de erro
        try {
            await updateUserBalance(telegramId, totalCost, 'refund', 
                `Reembolso - Erro na compra de ${quantity} ${itemDescription}(s)`, null, 'refund');
            bot.sendMessage(chatId, '❌ Erro no processamento da compra. Seu saldo foi reembolsado.');
        } catch (refundError) {
            console.error('Erro no reembolso:', refundError);
            bot.sendMessage(chatId, '❌ Erro crítico na compra. Entre em contato com o suporte.');
        }
    }
});

// Comando para listar preços
bot.onText(/\/precos/, async (msg) => {
    const chatId = msg.chat.id;
    
    const priceList = `💰 **Lista de Preços** 💰\n\n` +
                     `🎯 **GG (Gift Cards):**\n` +
                     `• Preço: R$ 10,00 cada\n` +
                     `• Exemplo: /comprar gg 5\n\n` +
                     `💳 **Cartões de Teste:**\n` +
                     `• Preço: R$ 5,00 cada\n` +
                     `• Exemplo: /comprar card 10\n\n` +
                     `⚡ **Limites:**\n` +
                     `• Máximo 50 itens por compra\n` +
                     `• Saldo mínimo necessário\n\n` +
                     `📊 **Status possíveis:**\n` +
                     `🟢 LIVE - Funcionando\n` +
                     `🔴 DIE - Não funcionando\n` +
                     `⚪ UNKNOWN - Status desconhecido`;

    bot.sendMessage(chatId, priceList, { parse_mode: 'Markdown' });
});

/**
 * Cria um pagamento com cartão de crédito via PagSeguro
 */
async function createPagSeguroCard(amount, telegramId, username, cardData) {
    try {
        const referenceId = `telegram-card-${telegramId}-${Date.now()}`;
        
        const orderData = {
            reference_id: referenceId,
            customer: {
                name: username || 'Cliente Telegram',
                email: `user${telegramId}@telegram.bot`,
                tax_id: "12345678909"
            },
            items: [{
                reference_id: "item-001",
                name: "Recarga de Saldo",
                quantity: 1,
                unit_amount: Math.round(amount * 100)
            }],
            charges: [{
                reference_id: referenceId,
                description: "Recarga de saldo via cartão",
                amount: {
                    value: Math.round(amount * 100),
                    currency: "BRL"
                },
                payment_method: {
                    type: "CREDIT_CARD",
                    installments: 1,
                    capture: true,
                    card: {
                        number: cardData.number,
                        exp_month: cardData.expMonth,
                        exp_year: cardData.expYear,
                        security_code: cardData.cvv,
                        holder: {
                            name: cardData.holderName || username || 'Cliente Telegram'
                        }
                    }
                }
            }],
            notification_urls: [`${process.env.WEBHOOK_URL}/webhook/pagseguro`]
        };

        const response = await axios.post(PAGBANK_API_URL, orderData, {
            headers: {
                'Authorization': `Bearer ${PAGBANK_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        return {
            success: true,
            orderId: response.data.id,
            status: response.data.charges[0].status,
            referenceId
        };

    } catch (error) {
        console.error('Erro ao processar cartão PagSeguro:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.error_messages || 'Erro desconhecido'
        };
    }
}

// --- Comandos do Bot ---

// Comando /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'Usuário';

    const user = await findOrCreateUser(telegramId, username);
    
    const welcomeMessage = `🎮 Olá, ${username}! Bem-vindo ao bot de GGs e cartões de teste!\n\n` +
        `💰 Seu saldo atual: R$ ${user.balance.toFixed(2)}\n\n` +
        `📋 Comandos disponíveis:\n` +
        `/saldo - Ver seu saldo atual\n` +
        `/depositar <valor> - Fazer depósito via PIX\n` +
        `/depositarcartao <valor> - Depositar via cartão\n` +
        `/comprar <tipo> <qtd> - Comprar GGs ou cartões\n` +
        `   Tipos: gg, card\n` +
        `   Ex: /comprar gg 5\n\n` +
        `💳 Métodos de pagamento:\n` +
        `• PIX (Wegate ou PagSeguro)\n` +
        `• Cartão de Crédito (PagSeguro)`;

    bot.sendMessage(chatId, welcomeMessage);
});

// Comando /saldo
bot.onText(/\/saldo/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    const user = await User.findByPk(telegramId);
    if (user) {
        // Buscar últimas transações
        const recentTransactions = await Transaction.findAll({
            where: { userId: telegramId },
            order: [['timestamp', 'DESC']],
            limit: 5
        });

        let message = `💰 Seu saldo atual: R$ ${user.balance.toFixed(2)}\n\n`;
        
        if (recentTransactions.length > 0) {
            message += `📊 Últimas transações:\n`;
            recentTransactions.forEach(transaction => {
                const icon = transaction.type === 'deposit' ? '➕' : transaction.type === 'purchase' ? '➖' : '🔄';
                const date = new Date(transaction.timestamp).toLocaleDateString('pt-BR');
                message += `${icon} R$ ${Math.abs(transaction.amount).toFixed(2)} - ${transaction.description} (${date})\n`;
            });
        }

        bot.sendMessage(chatId, message);
    } else {
        bot.sendMessage(chatId, 'Você ainda não está registrado. Use /start para criar uma conta.');
    }
});

// Comando /depositar <valor> - PIX via PagSeguro ou Wegate
bot.onText(/\/depositar (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const amount = parseFloat(match[1]);

    if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, '❌ Por favor, informe um valor positivo para depósito.\n📝 Ex: /depositar 10');
    }

    if (amount < 1) {
        return bot.sendMessage(chatId, '❌ Valor mínimo para depósito: R$ 10,0');
    }

    const user = await User.findByPk(telegramId);
    if (!user) {
        return bot.sendMessage(chatId, 'Você ainda não está registrado. Use /start para criar uma conta antes de depositar.');
    }

    // Botão único para PIX PagSeguro
    const keyboard = {
        inline_keyboard: [
            [
                { text: '🟢 PIX PagSeguro', callback_data: `pix_pagseguro_${amount}` }
            ]
        ]
    };

    bot.sendMessage(chatId, `💳 Depositar R$ ${amount.toFixed(2)} via PIX:`, {
        reply_markup: keyboard
    });
});

// Comando /depositarcartao <valor>
bot.onText(/\/depositarcartao (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const amount = parseFloat(match[1]);

    if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, '❌ Por favor, informe um valor positivo para depósito.\n📝 Ex: /depositarcartao 50');
    }

    if (amount < 5) {
        return bot.sendMessage(chatId, '❌ Valor mínimo para depósito via cartão: R$ 5,00');
    }

    const user = await User.findByPk(telegramId);
    if (!user) {
        return bot.sendMessage(chatId, 'Você ainda não está registrado. Use /start para criar uma conta antes de depositar.');
    }

    // Solicita dados do cartão
    bot.sendMessage(chatId, `💳 Para depositar R$ ${amount.toFixed(2)} via cartão, envie os dados no formato:\n\n` +
        `📝 Formato: NÚMERO MESVENC ANOVENC CVV NOME\n` +
        `📝 Exemplo: 4111111111111111 12 2025 123 João Silva\n\n` +
        `⚠️ Os dados serão processados de forma segura pelo PagSeguro.`);
        
    // Aguarda próxima mensagem com dados do cartão
    bot.once('message', async (cardMsg) => {
        if (cardMsg.from.id !== telegramId) return;
        
        const cardInfo = cardMsg.text.trim().split(' ');
        if (cardInfo.length < 5) {
            return bot.sendMessage(chatId, '❌ Formato inválido. Use: NÚMERO MÊS ANO CVV NOME COMPLETO');
        }

        const cardData = {
            number: cardInfo[0],
            expMonth: cardInfo[1],
            expYear: cardInfo[2],
            cvv: cardInfo[3],
            holderName: cardInfo.slice(4).join(' ')
        };

        bot.sendMessage(chatId, '⏳ Processando pagamento...');

        try {
            const result = await createPagSeguroCard(amount, telegramId, user.username, cardData);
            
            if (result.success) {
                if (result.status === 'PAID') {
                    await updateUserBalance(telegramId, amount, 'deposit', 
                        `Depósito via cartão - PagSeguro`, result.orderId, 'credit_card');
                    bot.sendMessage(chatId, `✅ Pagamento aprovado!\n💰 R$ ${amount.toFixed(2)} foi adicionado ao seu saldo.`);
                } else {
                    bot.sendMessage(chatId, `⏳ Pagamento em processamento.\nStatus: ${result.status}\nVocê será notificado quando for aprovado.`);
                }
            } else {
                bot.sendMessage(chatId, `❌ Erro no pagamento: ${result.error || 'Erro desconhecido'}`);
            }
        } catch (error) {
            console.error('Erro no processamento do cartão:', error);
            bot.sendMessage(chatId, '❌ Erro interno no processamento. Tente novamente mais tarde.');
        }
    });
});

// Handler para callbacks dos botões inline
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const telegramId = callbackQuery.from.id;
    const data = callbackQuery.data;

    try {
        if (data.startsWith('pix_pagseguro_')) {
            const amount = parseFloat(data.replace('pix_pagseguro_', ''));
            await handlePagSeguroPIX(chatId, telegramId, amount);
        }
        
        bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Erro no callback query:', error);
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Erro interno. Tente novamente.' });
    }
});

// Função para processar PIX PagSeguro
async function handlePagSeguroPIX(chatId, telegramId, amount) {
    try {
        const user = await User.findByPk(telegramId);
        
        if (!user) {
            return bot.sendMessage(chatId, '❌ Usuário não encontrado. Use /start para se registrar.');
        }
        
        bot.sendMessage(chatId, '⏳ Gerando PIX PagSeguro...');

        const result = await createPagSeguroPIX(amount, telegramId, user.username);
        
        if (result.success) {
            try {
                // Gera QR Code a partir do código PIX
                const qrCodeBuffer = await qrcode.toBuffer(result.pixCode);
                
                bot.sendPhoto(chatId, qrCodeBuffer, {
                    caption: `💰 PIX PagSeguro - R$ ${amount.toFixed(2)}\n\n` +
                             `📱 Código PIX Copia e Cola:\n\`${result.pixCode}\`\n\n` +
                             `⏰ Válido por 30 minutos\n` +
                             `✅ Seu saldo será creditado automaticamente após o pagamento.`,
                    parse_mode: 'Markdown'
                });
            } catch (qrError) {
                console.error('Erro ao gerar QR Code:', qrError);
                bot.sendMessage(chatId, `💰 PIX PagSeguro - R$ ${amount.toFixed(2)}\n\n` +
                               `📱 Código PIX Copia e Cola:\n\`${result.pixCode}\`\n\n` +
                               `⏰ Válido por 30 minutos\n` +
                               `✅ Seu saldo será creditado automaticamente após o pagamento.`,
                               { parse_mode: 'Markdown' });
            }
        } else {
            bot.sendMessage(chatId, `❌ Erro ao gerar PIX PagSeguro: ${result.error || 'Erro desconhecido'}`);
        }
    } catch (error) {
        console.error('Erro no handlePagSeguroPIX:', error);
        bot.sendMessage(chatId, '❌ Erro interno. Tente novamente mais tarde.');
    }
}



// Comando /comprar <tipo> <quantidade>
bot.onText(/\/comprar (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const itemType = match[1].toLowerCase();
    const quantity = parseInt(match[2]);

    if (isNaN(quantity) || quantity <= 0) {
        return bot.sendMessage(chatId, '❌ Quantidade inválida. Use um número positivo.\n📝 Ex: /comprar gg 1');
    }

    const user = await User.findByPk(telegramId);
    if (!user) {
        return bot.sendMessage(chatId, 'Você ainda não está registrado. Use /start para criar uma conta.');
    }

    let pricePerItem = 0;
    let generateFunction;
    let itemDescription = '';

    switch (itemType) {
        case 'gg':
            pricePerItem = 10.0; // Preço por GG
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
            return bot.sendMessage(chatId, '❌ Tipo de item inválido.\n✅ Escolha "gg" ou "card".');
    }

    const totalCost = quantity * pricePerItem;

    if (user.balance < totalCost) {
        return bot.sendMessage(chatId, `❌ Saldo insuficiente!\n💰 Necessário: R$ ${totalCost.toFixed(2)}\n💳 Seu saldo: R$ ${user.balance.toFixed(2)}\n\n💡 Use /depositar para recarregar.`);
    }
    
    const updatedUser = await updateUserBalance(telegramId, -totalCost, 'purchase', `Compra de ${quantity} ${itemDescription}(s)`);

    let generatedItems = [];
    let responseMessage = `✅ Compra realizada com sucesso!\n💰 Saldo restante: R$ ${updatedUser.balance.toFixed(2)}\n\n🎯 Seus ${itemDescription}(s):\n\`\`\`\n`;

    for (let i = 0; i < quantity; i++) {
        const item = generateFunction();
        const itemStatus = await checkGGStatus(itemType, item); 
        generatedItems.push(`${item} [${itemStatus}]`);
    }
    responseMessage += `${generatedItems.join('\n')}\n\`\`\``;

    bot.sendMessage(chatId, responseMessage, { parse_mode: 'Markdown' });
});

// Comandos de Administrador (mantidos os existentes)
bot.onText(/\/setsaldo (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminTelegramId = msg.from.id;
    const targetTelegramId = parseInt(match[1]);
    const amount = parseFloat(match[2]);

    const adminUser = await User.findByPk(adminTelegramId);
    if (!adminUser || !adminUser.isAdmin) {
        return bot.sendMessage(chatId, '❌ Acesso negado. Você não tem permissão de administrador.');
    }

    if (isNaN(targetTelegramId) || isNaN(amount)) {
        return bot.sendMessage(chatId, '❌ Uso: /setsaldo <ID_do_usuário> <valor>\n📝 Ex: /setsaldo 123456789 100');
    }

    const targetUser = await User.findByPk(targetTelegramId);
    if (!targetUser) {
        return bot.sendMessage(chatId, `❌ Usuário com ID ${targetTelegramId} não encontrado.`);
    }

    try {
        const updatedUser = await updateUserBalance(targetTelegramId, amount, 'admin_adjustment', `Ajuste de saldo por admin ${adminTelegramId}`);
        bot.sendMessage(chatId, `✅ Saldo ajustado!\n👤 ${updatedUser.username} (${updatedUser.telegramId})\n💰 Novo saldo: R$ ${updatedUser.balance.toFixed(2)}`);
    } catch (error) {
        console.error('Erro ao ajustar saldo por admin:', error);
        bot.sendMessage(chatId, '❌ Erro ao ajustar o saldo.');
    }
});

bot.onText(/\/report/, async (msg) => {
    const chatId = msg.chat.id;
    const adminTelegramId = msg.from.id;

    const adminUser = await User.findByPk(adminTelegramId);
    if (!adminUser || !adminUser.isAdmin) {
        return bot.sendMessage(chatId, '❌ Acesso negado. Você não tem permissão de administrador.');
    }

    try {
        const users = await User.findAll({
            order: [['balance', 'DESC']],
        });

        let reportMessage = '📊 **Relatório de Usuários** 📊\n\n';
        reportMessage += `👥 Total: ${users.length} usuários\n\n`;

        if (users.length === 0) {
            reportMessage += 'Nenhum usuário registrado.\n';
        } else {
            for (const user of users) {
                reportMessage += `👤 ${user.username} (ID: ${user.telegramId})\n`;
                reportMessage += `💰 Saldo: R$ ${user.balance.toFixed(2)}\n`;
                reportMessage += `🔑 Admin: ${user.isAdmin ? 'Sim' : 'Não'}\n`;
                reportMessage += `📅 Cadastro: ${user.createdAt.toLocaleDateString('pt-BR')}\n`;
                reportMessage += `📈 Última atividade: ${user.updatedAt.toLocaleDateString('pt-BR')}\n`;
                reportMessage += '─────────────────────\n';
            }

            // Estatísticas adicionais
            const totalBalance = users.reduce((sum, user) => sum + parseFloat(user.balance), 0);
            const adminsCount = users.filter(user => user.isAdmin).length;
            const activeUsers = users.filter(user => {
                const daysDiff = (new Date() - new Date(user.updatedAt)) / (1000 * 60 * 60 * 24);
                return daysDiff <= 7; // Usuários ativos na última semana
            }).length;

            reportMessage += '\n📈 **Estatísticas Gerais**\n';
            reportMessage += `💵 Saldo total no sistema: R$ ${totalBalance.toFixed(2)}\n`;
            reportMessage += `👑 Administradores: ${adminsCount}\n`;
            reportMessage += `🟢 Usuários ativos (7 dias): ${activeUsers}\n`;
            reportMessage += `📊 Saldo médio por usuário: R$ ${(totalBalance / users.length).toFixed(2)}\n`;
        }

        // Dividir mensagem se for muito longa (limite do Telegram é ~4096 caracteres)
        if (reportMessage.length > 4000) {
            const messages = [];
            let currentMessage = '';
            const lines = reportMessage.split('\n');

            for (const line of lines) {
                if ((currentMessage + line + '\n').length > 4000) {
                    messages.push(currentMessage);
                    currentMessage = line + '\n';
                } else {
                    currentMessage += line + '\n';
                }
            }
            
            if (currentMessage) {
                messages.push(currentMessage);
            }

            // Enviar mensagens divididas
            for (let i = 0; i < messages.length; i++) {
                const messageToSend = i === 0 
                    ? messages[i] 
                    : `📊 **Relatório de Usuários (Continuação ${i + 1})** 📊\n\n${messages[i]}`;
                
                await bot.sendMessage(chatId, messageToSend, { parse_mode: 'Markdown' });
                
                // Pequeno delay entre mensagens para evitar rate limiting
                if (i < messages.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        } else {
            await bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
        }

    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        bot.sendMessage(chatId, '❌ Erro interno do servidor. Tente novamente mais tarde.');
    }
});
