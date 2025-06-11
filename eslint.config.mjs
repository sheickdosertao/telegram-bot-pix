import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // Configurações básicas para arquivos JS/MJS/CJS
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"]
  },
  // Configuração específica para arquivos .js que usam CommonJS (require/exports)
  // Esta parte já estava correta, mas garante que o 'sourceType' seja 'commonjs'
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      // Adicione globals.node para reconhecer variáveis globais do Node.js
      globals: {
        ...globals.node, // Adiciona globais como 'process', 'require', '__dirname', '__filename'
        // ... você pode adicionar outros globais específicos aqui, se necessário.
        // Por exemplo, se seu código também rodasse no navegador e Node.js no mesmo arquivo,
        // você poderia ter { ...globals.browser, ...globals.node } e depois refinar.
      }
    }
  },
  // A linha abaixo estava causando o problema, pois definia globals.browser.
  // Ela será removida ou modificada para usar globals.node.
  // Removi esta linha: { files: ["**/*.{js,mjs,cjs}"], languageOptions: { globals: globals.browser } },
  // A configuração de 'globals' foi movida para o bloco CommonJS acima,
  // ou você pode ter um bloco global se a maioria dos seus arquivos forem Node.js.
  // Para a maioria dos cenários de bot em Node.js, ter um bloco de configuração geral
  // com `globals.node` para todos os arquivos `js/mjs/cjs` é o mais prático.
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
        globals: {
            ...globals.node, // Garante que todos os arquivos JS/MJS/CJS reconheçam as globais do Node.js
        }
    }
  }
]);