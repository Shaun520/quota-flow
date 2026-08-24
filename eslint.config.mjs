import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config({
  files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
  extends: [tseslint.configs.recommended, prettier],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    // 以下为风格类规则，legacy 代码大量违规；lint 仅作辅助不作硬门槛，统一放宽
    "@typescript-eslint/no-empty-object-type": "off",
    "prefer-const": "off",
    "prefer-rest-params": "off",
  },
});