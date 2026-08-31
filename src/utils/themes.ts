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
      '--app-surface': 'rgb(28, 28, 28)',
      '--app-card-active': 'rgb(43, 43, 43)',
      '--app-button-text': 'rgb(0, 0, 0)',
      '--app-text-primary': 'rgb(232, 234, 237)',
      '--app-text-secondary': 'rgb(158, 158, 158)',
      '--app-accent': 'rgb(24, 132, 111)',
      '--app-accent-hover': 'rgb(32, 150, 126)',
      '--app-accent-subtle': 'rgba(24, 132, 111, 0.15)',
      '--app-border-color': 'rgb(45, 45, 45)',
      '--app-hover-color': 'rgb(24, 132, 111)',
      '--app-success': 'rgb(76, 175, 80)',
      '--app-warning': 'rgb(255, 152, 0)',
      '--app-error': 'rgb(244, 67, 54)',
      '--app-shadow': '0 2px 12px rgba(0, 0, 0, 0.4)',
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
      '--app-text-secondary': 'rgb(108, 108, 108)',
      '--app-accent': 'rgb(198, 142, 110)',
      '--app-accent-hover': 'rgb(212, 156, 124)',
      '--app-accent-subtle': 'rgba(198, 142, 110, 0.15)',
      '--app-border-color': 'rgb(224, 224, 224)',
      '--app-hover-color': 'rgb(198, 142, 110)',
      '--app-success': 'rgb(56, 142, 60)',
      '--app-warning': 'rgb(245, 124, 0)',
      '--app-error': 'rgb(211, 47, 47)',
      '--app-shadow': '0 2px 12px rgba(0, 0, 0, 0.08)',
    },
  },
  {
    id: Theme.Grey,
    name: 'settings.themes.grey',
    splashImage: '/splash-grey.jpg',
    cssVariables: {
      '--app-bg-primary': 'rgb(112, 112, 112)',
      '--app-bg-secondary': 'rgb(118, 118, 118)',
      '--app-surface': 'rgb(108, 108, 108)',
      '--app-card-active': 'rgb(133, 133, 133)',
      '--app-button-text': 'rgb(45, 45, 45)',
      '--app-text-primary': 'rgb(240, 240, 240)',
      '--app-text-secondary': 'rgb(180, 180, 180)',
      '--app-accent': 'rgb(220, 220, 220)',
      '--app-accent-hover': 'rgb(235, 235, 235)',
      '--app-accent-subtle': 'rgba(220, 220, 220, 0.15)',
      '--app-border-color': 'rgb(138, 138, 138)',
      '--app-hover-color': 'rgb(220, 220, 220)',
      '--app-success': 'rgb(76, 175, 80)',
      '--app-warning': 'rgb(255, 152, 0)',
      '--app-error': 'rgb(244, 67, 54)',
      '--app-shadow': '0 2px 12px rgba(0, 0, 0, 0.3)',
    },
  },
];

export const DEFAULT_THEME_ID = Theme.Dark;
