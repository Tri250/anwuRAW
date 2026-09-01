import { Theme } from '../components/ui/AppProperties';

export interface ThemeProps {
  cssVariables: any;
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
      '--app-bg-tertiary': 'rgb(30, 30, 30)',
      '--app-surface': 'rgb(28, 28, 28)',
      '--app-surface-secondary': 'rgb(22, 22, 22)',
      '--app-card-active': 'rgb(43, 43, 43)',
      '--app-button-text': 'rgb(0, 0, 0)',
      '--app-text-primary': 'rgb(232, 234, 237)',
      '--app-text-secondary': 'rgb(158, 158, 158)',
      '--app-text-tertiary': 'rgb(120, 120, 120)',
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
      '--app-bg-tertiary': 'rgb(238, 238, 238)',
      '--app-surface': 'rgb(241, 241, 241)',
      '--app-surface-secondary': 'rgb(238, 238, 238)',
      '--app-card-active': 'rgb(250, 250, 250)',
      '--app-button-text': 'rgb(255, 255, 255)',
      '--app-text-primary': 'rgb(20, 20, 20)',
      // 文本辅助色：rgb(85,85,85) 相对 rgb(245,245,245) 对比度 ~5.7:1，满足 WCAG AA；原 rgb(108,108,108) 仅 ~3.55:1 不达标。
      '--app-text-secondary': 'rgb(85, 85, 85)',
      '--app-text-tertiary': 'rgb(150, 150, 150)',
      '--app-accent': 'rgb(198, 142, 110)',
      '--app-border-color': 'rgb(216, 216, 216)',
      '--app-hover-color': 'rgb(198, 142, 110)',
    },
  },
  {
    id: Theme.Grey,
    name: 'settings.themes.grey',
    splashImage: '/splash-grey.jpg',
    cssVariables: {
      '--app-bg-primary': 'rgb(112, 112, 112)',
      '--app-bg-secondary': 'rgb(118, 118, 118)',
      '--app-bg-tertiary': 'rgb(105, 105, 105)',
      '--app-surface': 'rgb(108, 108, 108)',
      '--app-surface-secondary': 'rgb(102, 102, 102)',
      '--app-card-active': 'rgb(133, 133, 133)',
      '--app-button-text': 'rgb(45, 45, 45)',
      '--app-text-primary': 'rgb(240, 240, 240)',
      '--app-text-secondary': 'rgb(180, 180, 180)',
      '--app-text-tertiary': 'rgb(150, 150, 150)',
      '--app-accent': 'rgb(220, 220, 220)',
      '--app-border-color': 'rgb(138, 138, 138)',
      '--app-hover-color': 'rgb(220, 220, 220)',
    },
  },
];

export const DEFAULT_THEME_ID = Theme.Light;
