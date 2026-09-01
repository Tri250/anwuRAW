import { Theme } from '../components/ui/AppProperties';

export interface ThemeProps {
  cssVariables: Record<string, string>;
  id: Theme;
  name: string;
  splashImage: string;
}

export const THEMES: Array<ThemeProps> = [
  {
    id: Theme.Dark,
    name: 'settings.themes.dark',
    splashImage: '/splash-dark.jpg',
    cssVariables: {
      '--app-bg-primary': 'rgb(24, 24, 24)',
      '--app-bg-secondary': 'rgb(35, 35, 35)',
      '--app-surface': 'rgb(28, 28, 28)',
      '--app-card-active': 'rgb(43, 43, 43)',
      '--app-button-text': 'rgb(0, 0, 0)',
      '--app-text-primary': 'rgb(232, 234, 237)',
      '--app-text-secondary': 'rgb(158, 158, 158)',
      '--app-accent': 'rgb(24, 132, 111)',
      '--app-border-color': 'rgb(45, 45, 45)',
      '--app-hover-color': 'rgb(24, 132, 111)',
    },
  },
  {
    id: Theme.Light,
    name: 'settings.themes.light',
    splashImage: '/splash-light.jpg',
    cssVariables: {
      '--app-bg-primary': 'rgb(245, 245, 245)',
      '--app-bg-secondary': 'rgb(255, 255, 255)',
      '--app-surface': 'rgb(241, 241, 241)',
      '--app-card-active': 'rgb(250, 250, 250)',
      '--app-button-text': 'rgb(255, 255, 255)',
      '--app-text-primary': 'rgb(20, 20, 20)',
      // 文本辅助色：rgb(85,85,85) 相对 rgb(245,245,245) 对比度 ~5.7:1，满足 WCAG AA；原 rgb(108,108,108) 仅 ~3.55:1 不达标。
      '--app-text-secondary': 'rgb(85, 85, 85)',
      // accent 由 rgb(198,142,110) 加深为暖棕 rgb(138,99,77)：白字对比度由 2.80 提升至 ~5.29:1，
      // 满足 WCAG AA（按钮填充色 + 浅色主题前景色均达标）。
      '--app-accent': 'rgb(138, 99, 77)',
      '--app-border-color': 'rgb(216, 216, 216)',
      '--app-hover-color': 'rgb(138, 99, 77)',
    },
  },
  {
    id: Theme.Grey,
    name: 'settings.themes.grey',
    splashImage: '/splash-grey.jpg',
    cssVariables: {
      // GREY 调整为连贯深灰配色，保证 text-primary/text-secondary 在
      // 所有背景（bg-primary/bg-secondary/surface/card-active）上均满足 WCAG AA（≥4.5:1）。
      // 全对最小值为 text-secondary/card-active≈5.68:1。
      '--app-bg-primary': 'rgb(60, 60, 60)',
      '--app-bg-secondary': 'rgb(68, 68, 68)',
      '--app-surface': 'rgb(54, 54, 54)',
      '--app-card-active': 'rgb(76, 76, 76)',
      '--app-button-text': 'rgb(40, 40, 40)',
      '--app-text-primary': 'rgb(246, 246, 246)',
      '--app-text-secondary': 'rgb(210, 210, 210)',
      '--app-accent': 'rgb(220, 220, 220)',
      '--app-border-color': 'rgb(96, 96, 96)',
      '--app-hover-color': 'rgb(220, 220, 220)',
    },
  },
];

export const DEFAULT_THEME_ID = Theme.Light;
