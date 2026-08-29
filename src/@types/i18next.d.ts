import 'i18next';

// 保持 i18next 的类型宽松化：项目大量使用动态/模板字符串翻译键
// （如 `t(\`editor.adjustments.sections.${section}\`)`），
// 因此不声明严格的 resources 键集合，使 t() 接受任意 string 键并返回 string。
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
  }
}
