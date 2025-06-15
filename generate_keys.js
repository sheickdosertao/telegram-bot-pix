// generate_keys.js
var crypto = require('crypto');
var fs = require('fs'); // Módulo para manipular arquivos

crypto.generateKeyPair('rsa',
  {
    modulusLength: 2048, // Tamanho da chave em bits. 2048 é um bom padrão.
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
      // Opcional: passphrase para proteger a chave privada (recomendado para produção)
      // cipher: 'aes-256-cbc',
      // passphrase: 'sua_senha_secreta_aqui'
    }
  },
  (error, pubKey, pvtKey) => {
    if (error) {
      console.error("Erro ao gerar as chaves:", error);
      return;
    }

    console.log("--- CHAVE PÚBLICA (cole na PagBank) ---");
    console.log(pubKey);
    console.log("\n--- CHAVE PRIVADA (MUITO SECRETA - Não compartilhe!) ---");
    console.log(pvtKey);

    // Opcional: Salvar as chaves em arquivos para facilitar o uso
    fs.writeFileSync('public_key.pem', pubKey);
    fs.writeFileSync('private_key.pem', pvtKey);
    console.log("\nChaves salvas em public_key.pem e private_key.pem");

    console.log("\n*** IMPORTANTE: Copie o conteúdo da CHAVE PÚBLICA e registre no painel da PagBank.");
    console.log("*** A CHAVE PRIVADA DEVE SER MANTIDA EM LOCAL SEGURO (variáveis de ambiente, etc.) e NUNCA COMPARTILHADA.");
  }
);