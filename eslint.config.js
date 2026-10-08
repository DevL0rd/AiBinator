import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
    {
        files: ['src/**/*.ts', 'scripts/**/*.ts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
        languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
        plugins: { sonarjs },
        rules: {
            complexity: ['error', { max: 10 }],
            'max-depth': ['error', 4],
            'max-statements': ['error', 35],
            'max-lines-per-function': ['error', { max: 90, skipBlankLines: true }],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
            '@typescript-eslint/no-deprecated': 'error',
            'no-else-return': ['error', { allowElseIf: false }],
            'no-unneeded-ternary': 'error',
            'sonarjs/no-all-duplicated-branches': 'error',
            'sonarjs/no-collection-size-mischeck': 'error',
            'sonarjs/no-dead-store': 'error',
            'sonarjs/no-duplicated-branches': 'error',
            'sonarjs/no-identical-conditions': 'error',
            'sonarjs/no-identical-expressions': 'error',
            'sonarjs/no-inverted-boolean-check': 'error',
            'sonarjs/no-redundant-boolean': 'error',
            'sonarjs/no-redundant-jump': 'error',
            'sonarjs/no-unused-collection': 'error',
        },
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            'sonarjs/cognitive-complexity': ['error', 15],
            'max-lines-per-function': ['error', { max: 60 }],
            'max-params': ['error', 6],
        },
    },
);
