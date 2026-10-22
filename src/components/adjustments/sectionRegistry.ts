import type { ComponentType } from 'react';
import BasicAdjustments from './Basic';
import CurveGraph from './Curves';
import ColorPanel from './Color';
import DetailsPanel from './Details';
import EffectsPanel from './Effects';
import ChannelMixer from './ChannelMixer';

/**
 * 调整 section → 组件注册表（单一来源）。
 *
 * ControlsPanel 与 MasksPanel 共用此映射，键集合与 utils/adjustments.ts 的
 * ADJUSTMENT_SECTIONS 保持一致（不含 split_toning：该功能已并入色彩分级
 * ColorGrading 三色轮，v1.6.19 去重移除，后端字段仅作旧会话兼容保留）。
 */
export const ADJUSTMENT_SECTION_COMPONENTS: Record<string, ComponentType<any>> = {
  basic: BasicAdjustments,
  curves: CurveGraph,
  color: ColorPanel,
  details: DetailsPanel,
  effects: EffectsPanel,
  channel_mixer: ChannelMixer,
};
