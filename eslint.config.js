import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ignores:['dist/**','node_modules/**']}, js.configs.recommended, ...ts.configs.recommended, {files:['**/*.mjs'], languageOptions:{globals:{console:'readonly',performance:'readonly',process:'readonly',Buffer:'readonly',URL:'readonly',setTimeout:'readonly',clearTimeout:'readonly'}}});
