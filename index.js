// index.js
// Este arquivo inicia tanto o bot do Telegram quanto o servidor de webhook.

// Importa e executa o bot do Telegram
require('./bot'); 

// Importa e executa o servidor de webhook
require('./webhook');

// Você pode adicionar logs adicionais aqui se desejar
console.log('Ambos o bot e o servidor de webhook foram iniciados (via index.js).');
