import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook, act } from '@testing-library/react';
import BasicAdjustments, {
  getActiveSceneLabelKey,
  getActiveRecipeId,
  mapRecipeLutPaths,
} from '../../src/components/adjustments/Basic';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../src/utils/adjustments';
import { MASTER_RECIPES, recipeToAdjustmentValues, RECIPE_PARAMETER_RESET } from '../../src/utils/masterRecipes';
import { useEditorActions } from '../../src/hooks/useEditorActions';
import { useEditorStore } from '../../src/store/useEditorStore';
import { mockInvoke } from './setup';

// === TC-SCENE-* 系列:覆盖「场景风格」操作链路 ===
// 链路:Basic.tsx applySceneEnhance → setAdjustments(updater) → 后端 GPU 管线
// 重点回归:确定性治理域(切换场景不残留)、section 可见性强制开启、自动按钮联动
//
// === TC-RECIPE-* / TC-FILM-*:大师配方与胶片融合链路(移植自 RawLab/koudaixiangce) ===
// 大师配方 = 14 基础键 + HSL + 内置 LUT 的完整外观治理域;
// 胶片(内置胶片模拟 LUT)自 v1.6.19 起整合进「特效」面板 LUT 管理器,
// 经 useEditorActions.handleLutSelect 落 LUT 字段(仅 LUT 治理域),Basic 不再重复提供入口。

type Updater = (prev: Partial<Adjustments>) => Partial<Adjustments>;

const MOCK_RES_DIR = '/mock/resources';
const RECIPE_LUT_ENTRIES = MASTER_RECIPES.map((recipe) => ({
  name: recipe.lutFileName,
  path: `${MOCK_RES_DIR}/master_recipe_luts/${recipe.lutFileName}.cube`,
}));
const FILM_LUT_PATH = `${MOCK_RES_DIR}/film_luts/K-Portra 400.cube`;

/** 默认命令实现:配方 LUT 全量可用(胶片 LUT 列表由特效面板 LUTControl 自行拉取) */
const setupInvokeDefaults = () => {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_recipe_luts') return Promise.resolve(RECIPE_LUT_ENTRIES);
    if (cmd === 'load_and_parse_lut') return Promise.resolve({ size: 33 });
    return Promise.resolve([]);
  });
};

const renderBasic = (overrides: Partial<Adjustments> = {}, onAutoAdjust?: () => void) => {
  const setAdjustments = vi.fn();
  const utils = render(
    <BasicAdjustments
      adjustments={{ ...INITIAL_ADJUSTMENTS, ...overrides }}
      setAdjustments={setAdjustments}
      onAutoAdjust={onAutoAdjust}
    />,
  );
  return { setAdjustments, unmount: utils.unmount };
};

const applyUpdater = (updater: unknown, prev: Partial<Adjustments>) => {
  expect(typeof updater).toBe('function');
  return (updater as Updater)(prev);
};

const clickScene = (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: label }));
};

const clickRecipe = async (name: string, setAdjustments: ReturnType<typeof vi.fn>) => {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  // 触发态 click 对应的 updater 立即同步执行,与调用序号解耦
  const applyCall = setAdjustments.mock.calls.at(-1)![0];
  expect(typeof applyCall).toBe('function');
  return applyCall as Updater;
};

describe('TC-SCENE-01: 场景预设应用确定性治理域', () => {
  it('应用「人像」后治理域键全部落位,且域外参数(曲线/亮度/锐化)保留', () => {
    const prev: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      brightness: 1.5,
      sharpness: 30,
      curves: INITIAL_ADJUSTMENTS.curves,
      dehaze: 25,
      lumaNoiseReduction: 40,
    };
    const { setAdjustments } = renderBasic(prev);
    clickScene('人像');

    expect(setAdjustments).toHaveBeenCalledTimes(1);
    const next = applyUpdater(setAdjustments.mock.calls[0][0], prev);

    // 校准值生效
    expect(next.contrast).toBe(6);
    expect(next.vibrance).toBe(10);
    // 治理域残留清零:上一状态的 dehaze/NR 不泄漏
    expect(next.dehaze).toBe(0);
    expect(next.lumaNoiseReduction).toBe(0);
    expect(next.colorNoiseReduction).toBe(0);
    expect(next.temperature).toBe(0);
    expect(next.tint).toBe(0);
    // 域外用户创作参数保留
    expect(next.brightness).toBe(1.5);
    expect(next.sharpness).toBe(30);
    expect(next.curves).toBe(prev.curves);
    // 蒙版/几何等其余字段原样保留
    expect(next.masks).toBe(prev.masks);
    expect(next.crop).toBe(prev.crop);
  });

  it('应用「风景」后再应用「夜景」:NR 落位且 dehaze 归零(切换场景不残留)', () => {
    const { setAdjustments } = renderBasic();
    clickScene('风景');
    const afterLandscape = applyUpdater(setAdjustments.mock.calls[0][0], INITIAL_ADJUSTMENTS);
    expect(afterLandscape.dehaze).toBe(14);

    // 用真实 store 语义串联第二次更新
    clickScene('夜景');
    const afterNight = applyUpdater(setAdjustments.mock.calls[1][0], afterLandscape);
    expect(afterNight.lumaNoiseReduction).toBe(24);
    expect(afterNight.colorNoiseReduction).toBe(18);
    expect(afterNight.dehaze).toBe(0);
    expect(afterNight.saturation).toBe(8);
  });

  it('同一场景重复应用结果幂等(同一场景 = 同一结果)', () => {
    const { setAdjustments } = renderBasic({ ...INITIAL_ADJUSTMENTS, saturation: 90, exposure: 3 });
    clickScene('暖阳');
    const first = applyUpdater(setAdjustments.mock.calls[0][0], INITIAL_ADJUSTMENTS);
    clickScene('暖阳');
    const second = applyUpdater(setAdjustments.mock.calls[1][0], first);
    for (const key of Object.keys(first)) {
      expect(JSON.stringify(second[key])).toBe(JSON.stringify(first[key]));
    }
  });
});

describe('TC-SCENE-02: 场景预设强制开启所属 section 可见性', () => {
  it('basic/color/details 被隐藏时应用场景会重新开启,其余 section 状态保留', () => {
    const prev: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      sectionVisibility: {
        ...INITIAL_ADJUSTMENTS.sectionVisibility,
        basic: false,
        color: false,
        details: false,
        effects: false,
        curves: true,
      },
    };
    const { setAdjustments } = renderBasic(prev);
    clickScene('人像');

    const next = applyUpdater(setAdjustments.mock.calls[0][0], prev);
    expect(next.sectionVisibility?.basic).toBe(true);
    expect(next.sectionVisibility?.color).toBe(true);
    expect(next.sectionVisibility?.details).toBe(true);
    // 未治理的 section 不被顺手打开
    expect(next.sectionVisibility?.effects).toBe(false);
    expect(next.sectionVisibility?.curves).toBe(true);
  });
});

describe('TC-SCENE-04: 切换态识别(getActiveSceneLabelKey)', () => {
  const PORTRAIT_KEY = 'adjustments.basic.scene.prototypePortrait';
  const portraitState: Partial<Adjustments> = {
    exposure: 0,
    contrast: 6,
    highlights: -10,
    shadows: 14,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    saturation: -4,
    vibrance: 10,
    clarity: 10,
    dehaze: 0,
    lumaNoiseReduction: 0,
    colorNoiseReduction: 0,
  };

  it('初始中性状态不激活任何场景', () => {
    expect(getActiveSceneLabelKey(INITIAL_ADJUSTMENTS)).toBeNull();
  });

  it('治理域逐键一致时激活对应场景;域外参数差异不影响判定', () => {
    expect(getActiveSceneLabelKey(portraitState)).toBe(PORTRAIT_KEY);
    expect(
      getActiveSceneLabelKey({
        ...portraitState,
        brightness: 2,
        sharpness: 40,
        curves: INITIAL_ADJUSTMENTS.curves,
        toneMapper: 'agx',
      }),
    ).toBe(PORTRAIT_KEY);
  });

  it('治理域任一键被手动改动后即退出激活态', () => {
    expect(getActiveSceneLabelKey({ ...portraitState, contrast: 7 })).toBeNull();
    expect(getActiveSceneLabelKey({ ...portraitState, vibrance: 0 })).toBeNull();
  });
});

describe('TC-SCENE-05: 切换高亮与再次点击还原', () => {
  const portraitState: Partial<Adjustments> = {
    ...INITIAL_ADJUSTMENTS,
    contrast: 6,
    highlights: -10,
    shadows: 14,
    saturation: -4,
    vibrance: 10,
    clarity: 10,
  };

  it('激活场景高亮(bg-accent),未激活不高亮', () => {
    const { container } = render(<BasicAdjustments adjustments={portraitState} setAdjustments={vi.fn()} />);
    const activeBtn = screen.getByRole('button', { name: '人像' });
    const inactiveBtn = screen.getByRole('button', { name: '风景' });
    expect(activeBtn.className).toContain('bg-accent');
    expect(inactiveBtn.className).not.toContain('bg-accent');
    expect(container).toBeTruthy();
  });

  it('再次点击已激活场景 = 退出场景:治理域回归中性,域外参数保留', () => {
    const prev: Partial<Adjustments> = { ...portraitState, brightness: 1.2, sharpness: 35 };
    const setAdjustments = vi.fn();
    render(<BasicAdjustments adjustments={prev} setAdjustments={setAdjustments} />);
    clickScene('人像');

    const next = applyUpdater(setAdjustments.mock.calls[0][0], prev);
    expect(next.contrast).toBe(0);
    expect(next.vibrance).toBe(0);
    expect(next.clarity).toBe(0);
    expect(next.exposure).toBe(0);
    // 域外保留
    expect(next.brightness).toBe(1.2);
    expect(next.sharpness).toBe(35);
    // section 保持开启
    expect(next.sectionVisibility?.basic).toBe(true);
    expect(next.sectionVisibility?.color).toBe(true);
    expect(next.sectionVisibility?.details).toBe(true);
  });

  it('手动微调一个滑块后场景高亮消失(状态由值推导,非点击记忆)', () => {
    const tweaked = { ...portraitState, contrast: 8 };
    render(<BasicAdjustments adjustments={tweaked} setAdjustments={vi.fn()} />);
    expect(screen.getByRole('button', { name: '人像' }).className).not.toContain('bg-accent');
  });
});

describe('TC-SCENE-03: 「自动」按钮与蒙版路径', () => {
  it('点击「自动」触发 onAutoAdjust 回调(复用后端 perform_auto_analysis 链路)', () => {
    const onAutoAdjust = vi.fn();
    renderBasic({}, onAutoAdjust);
    fireEvent.click(screen.getByRole('button', { name: '自动' }));
    expect(onAutoAdjust).toHaveBeenCalledTimes(1);
  });

  it('isForMask=true(蒙版局部调整)不渲染场景增强块', () => {
    const setAdjustments = vi.fn();
    render(
      <BasicAdjustments
        adjustments={INITIAL_ADJUSTMENTS}
        setAdjustments={setAdjustments}
        isForMask
        onAutoAdjust={() => {}}
      />,
    );
    expect(screen.queryByText('场景风格')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '人像' })).not.toBeInTheDocument();
  });

  it('未提供 onAutoAdjust 时不渲染「自动」按钮,场景预设仍可用', () => {
    renderBasic();
    expect(screen.queryByRole('button', { name: '自动' })).not.toBeInTheDocument();
    clickScene('人像');
    expect(screen.getByRole('button', { name: '人像' })).toBeTruthy();
  });
});

describe('TC-RECIPE-01: 大师配方应用(参数 + HSL + LUT 完整落位)', () => {
  it('应用「滨田英明」:治理域(14 键 + HSL + LUT)归零后叠加校准值,域外保留', async () => {
    setupInvokeDefaults();
    const prev: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      brightness: 1.5,
      sharpness: 30,
      curves: INITIAL_ADJUSTMENTS.curves,
      vibrance: 20,
      dehaze: 25,
      masks: [],
    };
    const { setAdjustments } = renderBasic(prev);
    const applyRecipe = await clickRecipe('滨田英明', setAdjustments);
    const next = applyUpdater(applyRecipe, prev);

    // 配方六参校准值(koudai master-recipes.json 源值)
    expect(next.exposure).toBe(0.4);
    expect(next.contrast).toBe(-15);
    expect(next.highlights).toBe(-15);
    expect(next.shadows).toBe(20);
    expect(next.saturation).toBe(-8);
    expect(next.tint).toBe(5);
    // 场景残留清零(大师配方治理域覆盖 14 基础键)
    expect(next.vibrance).toBe(0);
    expect(next.clarity).toBe(0);
    expect(next.dehaze).toBe(0);
    expect(next.whites).toBe(0);
    expect(next.blacks).toBe(0);
    expect(next.temperature).toBe(0);
    expect(next.lumaNoiseReduction).toBe(0);
    expect(next.colorNoiseReduction).toBe(0);
    // HSL 8 通道逐值落位(hamada: yellows.hue=1, aquas.sat=4/lum=-1, oranges.sat=1, blues.sat=1)
    expect(next.hsl?.yellows).toEqual({ hue: 1, saturation: 0, luminance: 0 });
    expect(next.hsl?.aquas).toEqual({ hue: 0, saturation: 4, luminance: -1 });
    expect(next.hsl?.oranges).toEqual({ hue: 0, saturation: 1, luminance: 0 });
    expect(next.hsl?.blues).toEqual({ hue: 0, saturation: 1, luminance: 0 });
    expect(next.hsl?.reds).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    // 内置风格 LUT(display-referred):路径来自 list_recipe_luts 运行时解析
    expect(next.lutPath).toBe(`${MOCK_RES_DIR}/master_recipe_luts/hamada_daylight_pro_v2.cube`);
    expect(next.lutName).toBe('滨田英明');
    expect(next.lutIntensity).toBe(100);
    expect(next.lutIsSceneReferred).toBe(false);
    // 域外用户创作参数保留
    expect(next.brightness).toBe(1.5);
    expect(next.sharpness).toBe(30);
    expect(next.curves).toBe(prev.curves);
    expect(next.masks).toBe(prev.masks);
  });

  it('应用配方强制开启 basic/color/details/effects 四个 section', async () => {
    setupInvokeDefaults();
    const prev: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      sectionVisibility: {
        ...INITIAL_ADJUSTMENTS.sectionVisibility,
        basic: false,
        color: false,
        details: false,
        effects: false,
        curves: true,
      },
    };
    const { setAdjustments } = renderBasic(prev);
    const applyRecipe = await clickRecipe('保井崇志', setAdjustments);
    const next = applyUpdater(applyRecipe, prev);
    expect(next.sectionVisibility?.basic).toBe(true);
    expect(next.sectionVisibility?.color).toBe(true);
    expect(next.sectionVisibility?.details).toBe(true);
    expect(next.sectionVisibility?.effects).toBe(true);
    // 未治理的 section 不被顺手打开
    expect(next.sectionVisibility?.curves).toBe(true);
  });

  it('外观文件缺失时配方按钮标记不可用(aria-disabled)且不落任何参数', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_recipe_luts') {
        // 仅保井崇志可用,滨田英明 LUT 缺失
        return Promise.resolve(RECIPE_LUT_ENTRIES.filter((e) => e.name === 'takashi_yasui_zen'));
      }
      if (cmd === 'list_luts') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { setAdjustments } = renderBasic();
    const hamadaButton = await screen.findByRole('button', { name: '滨田英明' });
    // aria-disabled 而非原生 disabled：disabled 表单元素不派发 mouseover，
    // data-tooltip(缺失原因提示)会永不可见
    expect(hamadaButton).toBeEnabled();
    expect(hamadaButton).toHaveAttribute('aria-disabled', 'true');
    // 悬停可见缺失原因提示
    expect(hamadaButton).toHaveAttribute('data-tooltip', expect.stringContaining('滨田英明'));
    fireEvent.click(hamadaButton);
    const recipeCalls = setAdjustments.mock.calls;
    expect(recipeCalls.length).toBe(0);
  });
});

describe('TC-RECIPE-02: 大师配方激活态与再次点击还原', () => {
  it('getActiveRecipeId: 应用后激活;手动微调治理域任一键后退出;域外微调不退出', async () => {
    setupInvokeDefaults();
    const { setAdjustments } = renderBasic();
    const applyRecipe = await clickRecipe('滨田英明', setAdjustments);
    const applied = applyUpdater(applyRecipe, INITIAL_ADJUSTMENTS);
    expect(getActiveRecipeId(applied)).toBe('hamada_daylight_v2');

    // 治理域内手动微调 → 退出激活态
    expect(getActiveRecipeId({ ...applied, contrast: -14 })).toBeNull();
    expect(
      getActiveRecipeId({ ...applied, hsl: { ...applied.hsl!, blues: { hue: 0, saturation: 2, luminance: 0 } } }),
    ).toBeNull();
    expect(getActiveRecipeId({ ...applied, lutName: '其他外观' })).toBeNull();

    // 域外微调(亮度/曲线等)不影响激活态
    expect(getActiveRecipeId({ ...applied, brightness: 2, sharpness: 40 })).toBe('hamada_daylight_v2');
    // lutIntensity 视为用户微调,不退出激活态
    expect(getActiveRecipeId({ ...applied, lutIntensity: 60 })).toBe('hamada_daylight_v2');
  });

  it('再次点击已激活配方 = 退出配方:治理域回归中性,域外保留', async () => {
    setupInvokeDefaults();
    const { setAdjustments, unmount } = renderBasic();
    const applyFirst = await clickRecipe('滨田英明', setAdjustments);
    const applied = applyUpdater(applyFirst, INITIAL_ADJUSTMENTS);

    // 以 applied 状态重渲染,配方高亮,再次点击 = 退出(先卸载首次渲染,避免 screen 命中旧实例)
    unmount();
    const setAdjustments2 = vi.fn();
    render(<BasicAdjustments adjustments={{ ...INITIAL_ADJUSTMENTS, ...applied }} setAdjustments={setAdjustments2} />);
    const button = await screen.findByRole('button', { name: '滨田英明' });
    expect(button.className).toContain('bg-accent');
    // 等待配方 LUT 路径异步解析完成、按钮可用后再点击
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    const exitRecipe = setAdjustments2.mock.calls.at(-1)![0] as Updater;
    const next = applyUpdater(exitRecipe, applied);

    // 治理域(14 键 + HSL + LUT)全部回归中性
    expect(next.exposure).toBe(0);
    expect(next.contrast).toBe(0);
    expect(next.highlights).toBe(0);
    expect(next.shadows).toBe(0);
    expect(next.saturation).toBe(0);
    expect(next.tint).toBe(0);
    expect(next.vibrance).toBe(0);
    expect(next.hsl?.yellows).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    expect(next.hsl?.blues).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    expect(next.lutPath).toBeNull();
    expect(next.lutName).toBeNull();
    expect(next.lutIntensity).toBe(100);
    expect(next.lutIsSceneReferred).toBe(false);
    // 域外保留
    expect(next.brightness).toBe(applied.brightness);
  });

  it('配方→配方切换不残留:先「滨田英明」再「rkrkrk」,exposure/tint/HSL 全部被新配方覆写', async () => {
    setupInvokeDefaults();
    const { setAdjustments, unmount } = renderBasic();
    const applyFirst = await clickRecipe('滨田英明', setAdjustments);
    const first = applyUpdater(applyFirst, INITIAL_ADJUSTMENTS);

    unmount();
    const setAdjustments2 = vi.fn();
    render(<BasicAdjustments adjustments={{ ...INITIAL_ADJUSTMENTS, ...first }} setAdjustments={setAdjustments2} />);
    const applySecond = await clickRecipe('rkrkrk', setAdjustments2);
    const second = applyUpdater(applySecond, first);

    expect(second.exposure).toBe(0);
    expect(second.contrast).toBe(25);
    expect(second.highlights).toBe(-40);
    expect(second.saturation).toBe(15);
    expect(second.tint).toBe(5);
    expect(second.lutName).toBe('rkrkrk');
    expect(second.lutPath).toBe(`${MOCK_RES_DIR}/master_recipe_luts/rkrkrk_cyberpunk.cube`);
    // hamada 的 HSL 不残留(rkrkrk HSL 为全中性)
    expect(second.hsl?.yellows).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    expect(getActiveRecipeId(second)).toBe('rkrkrk_cyberpunk');
  });
});

describe('TC-FILM-01: 胶片链路(入口唯一化到特效面板 LUTControl)', () => {
  /** 将 store 重置为干净编辑态(handleLutSelect 经真实 store 链路验证) */
  const resetEditorStore = (overrides: Partial<Adjustments> = {}) => {
    useEditorStore.setState({ adjustments: { ...INITIAL_ADJUSTMENTS, ...overrides } } as never);
  };

  it('整合回归:Basic 面板不再渲染胶片组,list_luts 不再被 Basic 调用', async () => {
    setupInvokeDefaults();
    renderBasic();
    await screen.findByRole('button', { name: '人像' }); // 场景组正常渲染
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('list_recipe_luts'));
    // 内置胶片按钮与「中性」按钮已从调整面板移除
    expect(screen.queryByRole('button', { name: 'K-Portra 400' })).not.toBeInTheDocument();
    expect(screen.queryByText('中性')).not.toBeInTheDocument();
    // 重复入口已移除:Basic 不再拉取内置 LUT 列表(由特效面板 LUTControl 拉取)
    expect(mockInvoke).not.toHaveBeenCalledWith('list_luts');
  });

  it('选择内置胶片:LUT 字段落位(scene-referred),基础滑块与 HSL 不被触碰', async () => {
    setupInvokeDefaults();
    resetEditorStore({ contrast: 12, vibrance: 8 });
    const { result } = renderHook(() => useEditorActions());
    await act(async () => {
      await result.current.handleLutSelect(FILM_LUT_PATH, true);
    });

    const next = useEditorStore.getState().adjustments;
    expect(next.lutPath).toBe(FILM_LUT_PATH);
    // 名称由路径文件名推导(含扩展名),与 Effects 面板链路一致
    expect(next.lutName).toBe('K-Portra 400.cube');
    expect(next.lutIsSceneReferred).toBe(true);
    expect(next.lutIntensity).toBe(100);
    expect(next.lutSize).toBe(33);
    // 胶片 = LUT 选择,不治理任何滑块
    expect(next.contrast).toBe(12);
    expect(next.vibrance).toBe(8);
    expect(next.exposure).toBe(0);
    // effects section 强制开启
    expect(next.sectionVisibility?.effects).toBe(true);
  });

  it('选择用户导入的自定义 LUT:display-referred(lutIsSceneReferred=false)', async () => {
    setupInvokeDefaults();
    resetEditorStore();
    const { result } = renderHook(() => useEditorActions());
    await act(async () => {
      await result.current.handleLutSelect('/user/luts/MyCustomLut.cube', false);
    });

    const next = useEditorStore.getState().adjustments;
    expect(next.lutPath).toBe('/user/luts/MyCustomLut.cube');
    expect(next.lutName).toBe('MyCustomLut.cube');
    expect(next.lutIsSceneReferred).toBe(false);
  });

  it('LUT 解析失败时 toast 提示且不落任何 LUT 字段', async () => {
    mockInvoke.mockRejectedValue(new Error('boom'));
    resetEditorStore();
    const { result } = renderHook(() => useEditorActions());
    await act(async () => {
      await result.current.handleLutSelect(FILM_LUT_PATH, true);
    });

    const next = useEditorStore.getState().adjustments;
    expect(next.lutPath).toBeNull();
    expect(next.lutName).toBeNull();
  });

  it('胶片与场景可叠加:已激活场景的治理域取值不被胶片选择触碰', async () => {
    setupInvokeDefaults();
    // 人像场景治理域完整校准值(激活态由全部 14 键推导)
    resetEditorStore({ contrast: 6, highlights: -10, shadows: 14, saturation: -4, vibrance: 10, clarity: 10 });
    const { result } = renderHook(() => useEditorActions());
    await act(async () => {
      await result.current.handleLutSelect(FILM_LUT_PATH, true);
    });

    const next = useEditorStore.getState().adjustments;
    expect(next.contrast).toBe(6);
    expect(next.vibrance).toBe(10);
    expect(next.clarity).toBe(10);
    expect(next.lutPath).toBe(FILM_LUT_PATH);
    expect(getActiveSceneLabelKey(next)).toBe('adjustments.basic.scene.prototypePortrait');
  });
});

describe('TC-LOOK-01: 配方 LUT 路径解析(mapRecipeLutPaths)', () => {
  it('空安全:null/undefined/非数组一律得到空映射', () => {
    expect(mapRecipeLutPaths(null)).toEqual({});
    expect(mapRecipeLutPaths(undefined)).toEqual({});
    expect(mapRecipeLutPaths([])).toEqual({});
  });

  it('按文件名(lutFileName)建立 lutFileName → path 映射,非法项跳过', () => {
    const map = mapRecipeLutPaths([
      { name: 'hamada_daylight_pro_v2', path: '/res/hamada_daylight_pro_v2.cube' },
      { name: '', path: '/res/invalid.cube' },
      { name: 'no_path', path: '' },
    ]);
    expect(map).toEqual({ hamada_daylight_pro_v2: '/res/hamada_daylight_pro_v2.cube' });
  });

  it('14 个大师配方的 lutFileName 与内置 LUT 资源一一对应', async () => {
    setupInvokeDefaults();
    const resolved = mapRecipeLutPaths(
      (await mockInvoke.mockImplementation) && (await import('./setup'), RECIPE_LUT_ENTRIES),
    );
    for (const recipe of MASTER_RECIPES) {
      expect(resolved[recipe.lutFileName]).toBeTruthy();
    }
    expect(MASTER_RECIPES).toHaveLength(14);
    expect(new Set(MASTER_RECIPES.map((r) => r.id)).size).toBe(14);
  });
});

describe('TC-RECIPE-03: 配方 LUT 路径跨会话自愈', () => {
  const RECIPE = MASTER_RECIPES.find((r) => r.id === 'hamada_daylight_v2')!;
  const RESOLVED_PATH = `${MOCK_RES_DIR}/master_recipe_luts/hamada_daylight_pro_v2.cube`;

  it('旧会话失效的绝对路径在运行时解析后被回写为当前资源路径', async () => {
    setupInvokeDefaults();
    const stale: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      ...recipeToAdjustmentValues(RECIPE),
      lutPath: '/old/install/Resources/master_recipe_luts/hamada_daylight_pro_v2.cube',
    };
    const setAdjustments = vi.fn();
    render(<BasicAdjustments adjustments={{ ...INITIAL_ADJUSTMENTS, ...stale }} setAdjustments={setAdjustments} />);

    await waitFor(() => expect(setAdjustments).toHaveBeenCalled());
    const updater = setAdjustments.mock.calls.at(-1)![0] as Updater;
    const next = updater(stale);
    // 仅回写 lutPath(部分更新),配方其余治理域不变
    expect(next).toEqual({ lutPath: RESOLVED_PATH });
    // 若期间外观已被切换(lutName 不再指向该配方),自愈不得覆盖
    expect(updater({ ...stale, lutName: '其他外观' })).toEqual({});
  });

  it('已激活配方即使外观文件缺失也允许点击退出', async () => {
    mockInvoke.mockImplementation(() => Promise.resolve([]));
    const applied: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      ...recipeToAdjustmentValues(RECIPE),
      lutPath: '/missing/hamada_daylight_pro_v2.cube',
    };
    const setAdjustments = vi.fn();
    render(<BasicAdjustments adjustments={{ ...INITIAL_ADJUSTMENTS, ...applied }} setAdjustments={setAdjustments} />);

    const button = await screen.findByRole('button', { name: RECIPE.name });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    const updater = setAdjustments.mock.calls.at(-1)![0] as Updater;
    const next = updater(applied);
    // 退出配方:治理域回归中性,不因文件缺失而卡在激活态
    expect(next.lutPath).toBeNull();
    expect(next.lutName).toBeNull();
    expect(next.contrast).toBe(0);
    expect(next.exposure).toBe(0);
  });

  it('激活态 UI 语义:aria-pressed 正确反映推导态,激活 chip 悬停提示退出', async () => {
    setupInvokeDefaults();
    const applied: Partial<Adjustments> = { ...INITIAL_ADJUSTMENTS, ...recipeToAdjustmentValues(RECIPE) };
    const setAdjustments = vi.fn();
    const { unmount } = render(
      <BasicAdjustments adjustments={{ ...INITIAL_ADJUSTMENTS, ...applied }} setAdjustments={setAdjustments} />,
    );

    const button = await screen.findByRole('button', { name: RECIPE.name });
    // 激活态由当前值推导:应用态 → aria-pressed=true,tooltip 提示再次点击退出
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.getAttribute('data-tooltip')).toContain('退出');
    unmount();

    // 治理域手动微调 → 推导退出激活态(aria-pressed=false,tooltip 恢复配方介绍)
    const tweaked: Partial<Adjustments> = { ...INITIAL_ADJUSTMENTS, ...recipeToAdjustmentValues(RECIPE), contrast: 42 };
    render(<BasicAdjustments adjustments={{ ...INITIAL_ADJUSTMENTS, ...tweaked }} setAdjustments={vi.fn()} />);
    const tweakedButton = await screen.findByRole('button', { name: RECIPE.name });
    expect(tweakedButton).toHaveAttribute('aria-pressed', 'false');
    expect(tweakedButton.getAttribute('data-tooltip')).not.toContain('退出');
  });
});

describe('TC-LOOK-03: 跨组切换确定性(配方 ↔ 场景/胶片)', () => {
  const RECIPE = MASTER_RECIPES.find((r) => r.id === 'hamada_daylight_v2')!;

  /** 渲染处于配方激活态的面板,返回 setAdjustments */
  const renderWithRecipe = async () => {
    setupInvokeDefaults();
    const applied: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      ...recipeToAdjustmentValues(RECIPE),
      lutPath: `${MOCK_RES_DIR}/master_recipe_luts/hamada_daylight_pro_v2.cube`,
    };
    const setAdjustments = vi.fn();
    const { unmount } = render(
      <BasicAdjustments adjustments={{ ...INITIAL_ADJUSTMENTS, ...applied }} setAdjustments={setAdjustments} />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: RECIPE.name }).className).toContain('bg-accent'));
    return { applied, setAdjustments, unmount };
  };

  it('配方 → 场景:配方超集(HSL + LUT)随场景切换一并清除,不留混合态', async () => {
    const { applied, setAdjustments } = await renderWithRecipe();
    clickScene('人像');

    const next = applyUpdater(setAdjustments.mock.calls.at(-1)![0], applied);
    // 场景校准值落位
    expect(next.contrast).toBe(6);
    expect(next.vibrance).toBe(10);
    // 配方超集不残留:hamada 的 HSL 与 LUT 全部清除
    expect(next.hsl?.yellows).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    expect(next.hsl?.aquas).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    expect(next.lutPath).toBeNull();
    expect(next.lutName).toBeNull();
    expect(getActiveRecipeId(next)).toBeNull();
    expect(getActiveSceneLabelKey(next)).toBe('adjustments.basic.scene.prototypePortrait');
  });

  it('配方 → 胶片(经特效面板选 LUT):配方参数与 HSL 清除,胶片 LUT 落位', async () => {
    setupInvokeDefaults();
    const applied: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      ...recipeToAdjustmentValues(RECIPE),
      lutPath: `${MOCK_RES_DIR}/master_recipe_luts/hamada_daylight_pro_v2.cube`,
    };
    useEditorStore.setState({ adjustments: { ...INITIAL_ADJUSTMENTS, ...applied } } as never);
    const { result } = renderHook(() => useEditorActions());
    await act(async () => {
      await result.current.handleLutSelect(FILM_LUT_PATH, true);
    });

    const next = useEditorStore.getState().adjustments;
    // 配方 14 键 + HSL 全部归零
    expect(next.exposure).toBe(0);
    expect(next.contrast).toBe(0);
    expect(next.saturation).toBe(0);
    expect(next.tint).toBe(0);
    expect(next.hsl?.yellows).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    // 胶片 LUT 落位(scene-referred)
    expect(next.lutPath).toBe(FILM_LUT_PATH);
    expect(next.lutName).toBe('K-Portra 400.cube');
    expect(next.lutIsSceneReferred).toBe(true);
    expect(getActiveRecipeId(next)).toBeNull();
  });

  // 「配方 → 中性」用例已随胶片组整合移除:Basic 面板不再提供「中性」入口,
  // 完整退出配方 = 再次点击已激活配方(TC-RECIPE-02)或特效面板清除 LUT(TC-LOOK-03 重置常量用例)。

  it('Effects 链路共用语义:配方态经 RECIPE_PARAMETER_RESET 清理后激活态自然退出', () => {
    const RECIPE = MASTER_RECIPES[0];
    const recipeState: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      ...recipeToAdjustmentValues(RECIPE),
      lutPath: `${MOCK_RES_DIR}/master_recipe_luts/${RECIPE.lutFileName}.cube`,
    };
    expect(getActiveRecipeId(recipeState)).toBe(RECIPE.id);

    // useEditorActions.handleLutSelect / Effects.handleLutClear 共用同一判定与重置常量
    const cleared = { ...recipeState, ...RECIPE_PARAMETER_RESET };
    expect(getActiveRecipeId(cleared)).toBeNull();
    expect(cleared.contrast).toBe(0);
    expect(cleared.tint).toBe(0);
    expect(cleared.hsl?.yellows).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    // LUT 字段由调用方覆写,重置常量本身不包含 lutPath(避免误清场景叠加的胶片)
    expect('lutPath' in RECIPE_PARAMETER_RESET).toBe(false);
  });

  it('胶片 → 场景:叠加语义保持,胶片 LUT 不被场景切换清除', async () => {
    setupInvokeDefaults();
    const withFilm: Partial<Adjustments> = {
      ...INITIAL_ADJUSTMENTS,
      lutPath: `${MOCK_RES_DIR}/film_luts/K-Portra 400.cube`,
      lutName: 'K-Portra 400',
      lutIsSceneReferred: true,
    };
    const { setAdjustments } = renderBasic(withFilm);
    clickScene('人像');

    const next = applyUpdater(setAdjustments.mock.calls.at(-1)![0], withFilm);
    // 场景参数落位,胶片 LUT 保留(可叠加)
    expect(next.contrast).toBe(6);
    expect(next.vibrance).toBe(10);
    expect(next.lutPath).toBe(`${MOCK_RES_DIR}/film_luts/K-Portra 400.cube`);
    expect(next.lutName).toBe('K-Portra 400');
  });
});

describe('TC-LOOK-02: 后端 LUT 预热(load_and_parse_lut)', () => {
  it('应用配方/胶片后预热 LUT 缓存并回填 lutSize,引用不变时不重复落状态', async () => {
    setupInvokeDefaults();
    const { setAdjustments } = renderBasic();
    await clickRecipe('滨田英明', setAdjustments);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('load_and_parse_lut', {
        path: `${MOCK_RES_DIR}/master_recipe_luts/hamada_daylight_pro_v2.cube`,
      });
    });
    // 预热完成后回填 lutSize=33(仅当 lutPath 仍匹配)
    await waitFor(() => {
      const sizeCall = setAdjustments.mock.calls.find(
        ([updater]) =>
          typeof updater === 'function' &&
          (updater as Updater)({
            lutPath: `${MOCK_RES_DIR}/master_recipe_luts/hamada_daylight_pro_v2.cube`,
            lutSize: 0,
          }).lutSize === 33,
      );
      expect(sizeCall).toBeTruthy();
    });
  });
});
