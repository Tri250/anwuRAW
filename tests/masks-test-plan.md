# 蒙版功能 全覆盖测试用例与验收标准

> 范围:覆盖蒙版功能页面所有子模块(见前置清单"列出项目仓库蒙版功能页面所有的子功能模块名称列表")。
> 覆盖层面:前端 UI(MasksPanel / Masks / MaskEditingToolbar / maskUtils / useAiMasking)+ 后端 Rust(mask_generation / color_range_mask / luminance_range_mask)。
> 交付物:本用例文档 + `tests/frontend/`、`tests/rust/` 关键路径自动化测试代码。

---

## 0. 测试环境与基础设施

### 0.1 前端测试栈
| 项 | 选用 | 说明 |
|----|------|------|
| 测试框架 | Vitest | 复用 Vite pipeline,与 Tauri 不耦合 |
| DOM 测试 | @testing-library/react + jsdom | 渲染组件、断言交互 |
| 用户事件 | @testing-library/user-event | click/drag/keyboard |
| Mock | vi.mock + msw(可选) | mock `@tauri-apps/api/core` 的 `invoke` |
| 命令 | `npm run test` / `npm run test:coverage` | 见 `package.json` scripts |

### 0.2 后端测试栈
| 项 | 选用 | 说明 |
|----|------|------|
| 测试框架 | Rust 内置 `#[test]` | 无额外依赖,直接 `cargo test` |
| 图像断言 | `image` crate 0.25(已在依赖) | 构造测试图、读取像素、断言 mask 值 |
| 临时文件 | `tempfile` 3.27(已在依赖) | color/luminance 命令测试落盘 |
| 命令 | `cargo test --lib` | 跑 lib 目标,跳过 binary |

### 0.3 通用前置条件
- Node ≥ 20、Rust ≥ 1.96(rust-toolchain.toml)
- 运行测试不依赖 Tauri runtime、不依赖 GPU、不依赖 AI 模型下载
- i18n 文案测试使用 `zh-CN.json` 与 `en.json` 双语对照
- AI 命令路径(端侧/云)在前端做 mock,在后端做 fixture 像素断言

---

## 1. 面板分区模块(MasksPanel 三大分组)

涉及代码:[MasksPanel.tsx#L1089-L1122](file:///workspace/src/components/panel/right/MasksPanel.tsx#L1089-L1122)、[Masks.tsx#L132-L152](file:///workspace/src/components/panel/right/Masks.tsx#L132-L152)。

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-PANEL-01 | AI 选择分组(aiTitle) | 已加载一张图像进入编辑器 | 进入蒙版面板;查看"AI 选择"分组 | 显示 4 项:主体 / 天空 / 前景 / 深度,图标依次为 SquareMousePointer / Cloud / User / BringToFront | 4 项全部渲染,i18n key `masks.aiTitle` 与 `masks.types.{subject,sky,foreground,depth}` 文案在 zh-CN/en 下均存在 |
| TC-PANEL-02 | 基本工具分组(basicTitle) | 同上 | 查看"基本工具"分组 | 显示 4 项:画笔 / 线性 / 径向 / 流线 | 图标 Brush / TriangleRight / Circle / Droplets 正确;`MASK_BASIC_TYPES` 长度 === 4 |
| TC-PANEL-03 | 范围与全局分组(rangeTitle) | 同上 | 查看"范围与全局"分组 | 显示 3 项:颜色 / 亮度 / 整个图像 | `MASK_RANGE_TYPES` 长度 === 3;`Mask.All` 在 UI 文案显示为"整个图像" |
| TC-PANEL-04 | 全部蒙版常量合集 | 无 | 静态导入 `ALL_MASK_TYPES` | 数量 === 11(AI 4 + 基础 4 + 范围 3) | 与 `AI_SUB_MASK_COMPONENT_TYPES` 一起覆盖全部 17 种 `Mask` 枚举值 |
| TC-PANEL-05 | 子蒙版类型分组 | 进入"添加新组件"流程 | 查看可添加的子蒙版类型 | 显示 AI 直接修复(克隆/修复/自动消除)、AI 触点修饰(液化/修饰)、AI 生成创建(快速擦除/主体/前景/画笔/线性/径向)、其他(深度/颜色/亮度/画笔/流线/整个图像) | `AI_DIRECT_PATCH_TYPES.length === 3`、`AI_TOUCH_UP_TYPES.length === 2`、`AI_GENERATIVE_CREATION_TYPES.length === 6`、`OTHERS_MASK_TYPES.length === 6` |

**验收标准(模块级)**:
- 三大分组共渲染 11 个 DraggableGridItem,顺序与 `MASK_AI_TYPES / MASK_BASIC_TYPES / MASK_RANGE_TYPES` 一致。
- 每个分组的标题文案在 i18n 缺失时不崩溃(回退到默认英文字符串)。
- 分组之间渲染分隔线。

---

## 2. Mask 类型枚举与命名(Masks.tsx)

涉及代码:[Masks.tsx#L26-L110](file:///workspace/src/components/panel/right/Masks.tsx#L26-L110)。

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-MASK-01 | `Mask` 枚举完备性 | 无 | 静态断言 `Object.keys(Mask).length === 17` 与值不重复 | 17 个枚举值,涵盖 ai-depth/ai-foreground/ai-sky/ai-subject/all/brush/flow/color/linear/luminance/quick-eraser/radial/clone/heal/liquify/retouch/auto-erase | 枚举值与后端 `sub_mask.mask_type` 字符串严格一一对应 |
| TC-MASK-02 | `formatMaskTypeName` | 无 | 对每个 `Mask` 调用函数 | 全部返回非空本地化字符串;未命中分支回退到首字母大写 | i18n key `masks.types.{all,brush,clone,color,depth,flow,foreground,heal,linear,liquify,luminance,quickErase,quickEraser,radial,retouch,sky,subject,autoErase,others}` 在 zh-CN 与 en 下均存在 |
| TC-MASK-03 | `getMaskTypeName` | 无 | 传入 `id:'others'` 的 MaskType | 返回 `masks.types.others`("其他") | 优先级高于 type 本地化 |
| TC-MASK-04 | `getMaskTypeName` 快速擦除特殊分支 | 无 | 传入 `Mask.QuickEraser` + `name:'Quick Erase'` | 返回 `masks.types.quickErase`("快速擦除") | 与 `Mask.QuickEraser` 的 type 回退文案"快速橡皮擦"区分 |
| TC-MASK-05 | `getSubMaskName` 自定义名优先 | 无 | 传入 `name:'我的天空蒙版'` + `type:Mask.AiSky` | 返回 `'我的天空蒙版'` | name 为空白时回退到 `formatMaskTypeName(type)` |
| TC-MASK-06 | `MASK_ICON_MAP` 完备 | 无 | 对每个 `Mask` 取对应 icon | 17 个映射均存在且为 lucide 组件 | 缺失任一映射应在测试中失败 |
| TC-MASK-07 | `SubMaskMode` 枚举 | 无 | 静态断言 | 3 个值:additive / subtractive / intersect | 与后端 `SubMaskMode` 枚举序列化一致(`camelCase`) |
| TC-MASK-08 | `ToolType` 枚举 | 无 | 静态断言 | 5 个值:ai-selector / brush / eraser / generative-replace / select-subject | 与后端 `BrushLine.tool` 字符串一致 |

**验收标准(模块级)**:
- `formatMaskTypeName` 不存在返回 `undefined` 或空串的路径。
- 中英两套 i18n key 数量一致(由 `i18n:runtime-check` 保证)。

---

## 3. 创建子蒙版工厂函数(maskUtils.ts)

涉及代码:[maskUtils.ts](file:///workspace/src/utils/maskUtils.ts)。

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-CREATE-01 | 默认参数 | imageDimensions = {width:1000,height:1000} | 调用 `createSubMask(Mask.Radial, ...)` | 返回 id 非空、visible=true、invert=false、opacity=100、mode=Additive、name='径向' | 字段齐全且符合 `SubMask` 接口 |
| TC-CREATE-02 | Radial 参数几何 | 同上 | 检查 parameters | centerX=500、centerY=500、radiusX=250、radiusY=250、rotation=0、feather=0.5 | 几何中心位于图像中心 |
| TC-CREATE-03 | Linear 参数几何 | 同上 | 检查 parameters | startX=250、startY=500、endX=750、endY=500、range=50 | 起止点位于水平中线 |
| TC-CREATE-04 | Brush 空笔迹 | 同上 | 检查 parameters.lines | `[]` 空数组 | 后端渲染时跳过空 line |
| TC-CREATE-05 | Flow 默认 flow | 同上 | 检查 parameters.flow | 10 | 与后端 `default_line_flow` 一致 |
| TC-CREATE-06 | AI Subject 默认参数 | 同上 | 检查 parameters | maskDataBase64=null、grow=50、feather=25 | 与 `MASK_AI_TYPES` 默认配置一致 |
| TC-CREATE-07 | AI Foreground 默认参数 | 同上 | 检查 parameters | maskDataBase64=null、grow=50、feather=25 | 同上 |
| TC-CREATE-08 | QuickEraser 默认参数 | 同上 | 检查 parameters | maskDataBase64=null、grow=75、feather=75 | 与 `SUB_MASK_CONFIG` 默认值一致 |
| TC-CREATE-09 | 其他类型空参数 | 同上 | 调用 `createSubMask(Mask.Color, ...)` 等 | parameters === {} 空对象 | 后端反序列化走 `unwrap_or_default` 不崩溃 |
| TC-CREATE-10 | 无 imageDimensions 容错 | imageDimensions = null | 调用任一类型 | 回退到 {width:1000,height:1000},不抛异常 | 容错不破坏调用方 |
| TC-CREATE-11 | 自定义 mode | 无 | 传入 `SubMaskMode.Subtractive` | mode 字段 === 'subtractive' | 与后端 SubMaskMode 字符串一致 |

**验收标准(模块级)**:
- 全部 17 种 `Mask` 类型经 `createSubMask` 调用均不抛异常。
- 几何参数与图像尺寸成比例(防止 0 尺寸图像导致 NaN)。

---

## 4. SUB_MASK_CONFIG 参数配置表(MasksPanel.tsx)

涉及代码:[MasksPanel.tsx#L97-L156](file:///workspace/src/components/panel/right/MasksPanel.tsx#L97-L156)。

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-CONFIG-01 | Radial feather | 无 | 取 `SUB_MASK_CONFIG[Mask.Radial].parameters` | 含 `{key:'feather', min:0, max:100, step:1, multiplier:100, defaultValue:50}` | 滑杆范围与后端 `RadialMaskParameters.feather` 0..1 范围匹配(multiplier=100) |
| TC-CONFIG-02 | Color 四参数 | 无 | 取 `SUB_MASK_CONFIG[Mask.Color].parameters` | 4 个参数:tolerance/grow/feather/decontaminate,顺序与默认值与后端 `ParametricMaskParameters` 一致 | 任一缺失应失败 |
| TC-CONFIG-03 | Luminance 四参数 | 无 | 同上类型为 Luminance | 4 参数同 Color | 与后端共用 `ParametricMaskParameters` |
| TC-CONFIG-04 | AI Subject 三参数 | 无 | 取 AI Subject | grow=50 / feather=25 / decontaminate=20 | 与后端 `apply_grow_and_feather` 默认值一致 |
| TC-CONFIG-05 | AI Sky 三参数 | 无 | 同上类型为 AiSky | grow=0 / feather=0 / decontaminate=15 | feather=0 时后端跳过高斯模糊分支 |
| TC-CONFIG-06 | AI Depth 双参数 | 无 | 同上类型为 AiDepth | feather=15 / decontaminate=0 | 与 `generate_ai_depth_bitmap` 默认值一致 |
| TC-CONFIG-07 | All 空参数 | 无 | 同上类型为 All | parameters === [] | 后端 `generate_all_bitmap` 不读取参数 |
| TC-CONFIG-08 | 画笔类工具开关 | 无 | 取 Brush/Flow/QuickEraser/Clone/Heal/AutoErase/Liquify/Retouch | `showBrushTools === true` | 与 `MaskEditingToolbar.BRUSH_TOOL_TYPES` 一致 |
| TC-CONFIG-09 | Flow 流量开关 | 无 | 取 Flow | `showFlowControl === true` | 仅 Flow 类型独有 |

**验收标准(模块级)**:
- `SUB_MASK_CONFIG` 覆盖全部 17 个 `Mask` 键,无遗漏。
- 默认值与后端 `default_*` 函数返回值一致。

---

## 5. 画布蒙版编辑工具条(MaskEditingToolbar.tsx)

涉及代码:[MaskEditingToolbar.tsx](file:///workspace/src/components/panel/editor/MaskEditingToolbar.tsx)。

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-TB-01 | `showMaskEditingToolbar` 显隐 | 无 | 传入 null | 返回 false | 与传入非 null 但不在 `TOOLBAR_VISIBLE_TYPES` 列表中的类型同样返回 false |
| TC-TB-02 | `TOOLBAR_VISIBLE_TYPES` | 无 | 静态断言 | 包含 12 个类型(Brush/Flow/QuickEraser/Linear/Radial/Color/Luminance/Clone/Heal/AutoErase/Liquify/Retouch) | 不包含 AI 类型(AiSubject/AiForeground/AiSky/AiDepth)与 All |
| TC-TB-03 | `BRUSH_TOOL_TYPES` | 无 | 静态断言 | 8 个笔刷类工具 | 仅这些类型显示画笔/橡皮切换按钮 |
| TC-TB-04 | `STANDALONE_REPAIR` | 无 | 静态断言 | 5 个独立修复类型(Clone/Heal/AutoErase/Liquify/Retouch) | 这些类型不显示反选按钮 |
| TC-TB-05 | `STRENGTH_PARAM_KEY` 映射 | 无 | 调用函数(Liquify) | 返回 'pressure' | 调用(Retouch) → 'intensity';调用(AutoErase) → 'sensitivity';其他 → null |
| TC-TB-06 | `CLEAR_TYPES` | 无 | 静态断言 | 7 个类型(Brush/Flow/QuickEraser/Color/Luminance/AiSubject/AiForeground) | 仅这些类型显示"清除蒙版"按钮 |
| TC-TB-07 | 笔刷大小滑杆 | 渲染 Brush 子蒙版 | 拖动 brushSize 滑杆 | `onBrushSettingsChange({size: v})` 被调用,max=400 | 与 `BrushTools` 滑杆 max=200 不一致(画布工具条上限更高) |
| TC-TB-08 | 柔软度滑杆 | 同上 | 拖动 brushFeather 滑杆 | `onBrushSettingsChange({feather: v})` 被调用,max=100 | 与 `SUB_MASK_CONFIG` feather 范围一致 |
| TC-TB-09 | 强度滑杆 Liquify | 渲染 Liquify | 调整强度 | `onStrengthChange` 被调用,读取 `subMask.parameters.pressure` | 默认值回退到 40 |
| TC-TB-10 | 强度滑杆 Retouch | 渲染 Retouch | 同上 | 读取 `parameters.intensity` | 同上 |
| TC-TB-11 | 强度滑杆 AutoErase | 渲染 AutoErase | 同上 | 读取 `parameters.sensitivity` | 同上 |
| TC-TB-12 | 反选按钮显隐 | 渲染 Brush | 检查 invert 按钮 | 显示 | 渲染 Clone 时不显示 |
| TC-TB-13 | 清除按钮显隐 | 渲染 Color | 检查 clear 按钮 | 显示 | 渲染 AiSky 时不显示(不在 CLEAR_TYPES) |
| TC-TB-14 | 完成按钮 | 任一可见类型 | 点击 Done | `onDone` 被调用 | 始终显示 |
| TC-TB-15 | 蒙版叠加显隐切换 | 任一可见类型 | 点击眼睛图标 | `onToggleOverlay` 被调用,图标在 Eye/EyeOff 间切换 | `maskOverlayVisible` 切换 |
| TC-TB-16 | 笔刷/橡皮切换 | 渲染 Brush | 点击 Brush | `onBrushToolChange(ToolType.Brush)` | 按钮 active 态切换为 bg-accent |
| TC-TB-17 | 标题文案 | 渲染子蒙版 | 查看 toolbar title | 显示 `editor.masks.toolbar.title` + 子蒙版名 | 子蒙版名通过 `getSubMaskName` 取得 |

**验收标准(模块级)**:
- 工具条对所有 12 个 `TOOLBAR_VISIBLE_TYPES` 均能渲染不抛错。
- 滑杆值不会因 `subMask.parameters` 为 undefined 而崩溃(回退默认值)。
- 完成按钮始终可点击(无 disabled 状态)。

---

## 6. AI 蒙版 Hook(useAiMasking.ts)

涉及代码:[useAiMasking.ts](file:///workspace/src/hooks/useAiMasking.ts)。需 mock `@tauri-apps/api/core` 的 `invoke` 与 `@clerk/react` 的 `useAuth`。

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-AI-01 | `updateSubMask` | 渲染 hook | 调用并传入 subMaskId + 更新数据 | masks 与 aiPatches 内对应 subMask 被更新 | 闭包不引用旧 state |
| TC-AI-02 | `handleGenerateAiMask` 成功 | selectedImage.path 已设置,mock invoke 返回 newParameters | 调用 handleGenerateAiMask | isGeneratingAiMask 置 true→false,subMask.parameters 合并新参数 | patchesSentToBackend.delete 被调用 |
| TC-AI-03 | `handleGenerateAiMask` 失败 | mock invoke reject | 同上 | toast.error 被调用,isGeneratingAiMask 复位为 false | 不阻塞后续调用 |
| TC-AI-04 | `handleGenerateAiSkyMask` | 同上但调用 sky | 调用 | 命令名 === `GenerateAiSkyMask`,参数含 flip/rotation/orientationSteps | 与后端命令签名一致 |
| TC-AI-05 | `handleGenerateAiForegroundMask` | 同上但调用 foreground | 调用 | 命令名 === `GenerateAiForegroundMask` | 同上 |
| TC-AI-06 | `handleGenerateAiDepthMask` | 传入 parameters | 调用 | 命令名 === `generate_ai_depth_mask`,参数含 minDepth/maxDepth/minFade/maxFade/feather | 默认回退:minDepth=20/maxDepth=100/minFade=15/maxFade=15/feather=10 |
| TC-AI-07 | `handleDirectPatch` 命令分发 | patch 含 auto-erase 子蒙版 | 调用 | 命令 === `generate_auto_erase_patch` | 同样地 liquify → `generate_liquify_patch`,retouch → `generate_retouch_patch`,其他 → `generate_manual_cleanup_patch` |
| TC-AI-08 | `handleDirectPatch` 切图丢弃 | invoke 返回前切换 selectedImage.path | 调用 | 旧结果被丢弃,不更新新图 aiPatches | 防止 stale update |
| TC-AI-09 | `handleGenerativeReplace` 端侧 | useFastInpaint=true | 调用 | 不调用 `getToken`,命令 === `InvokeGenerativeReplaseWithMaskDef`,token=null | 端侧 Lama 不需要鉴权 |
| TC-AI-10 | `handleGenerativeReplace` 云端 | useFastInpaint=false,getToken 成功 | 调用 | 调用 `getToken`,token 透传给后端 | 失败时 token=null 不阻塞 |
| TC-AI-11 | `handleQuickErase` 两阶段 | mock GenerateAiSubjectMask + InvokeGenerativeReplaseWithMaskDef | 调用 | 先生成蒙版参数,再生成 patch 数据,useFastInpaint=true | 始终端侧执行 |
| TC-AI-12 | `handleDeleteMaskContainer` | 存在 container 与 activeMaskContainerId 相等 | 调用 | masks 数组过滤掉该 container,activeMaskContainerId/activeMaskId 复位 null | 不影响其他 container |
| TC-AI-13 | `handleDeleteAiPatch` | 同上但作用于 aiPatches | 调用 | aiPatches 过滤,activeAiPatchContainerId/activeAiSubMaskId 复位 | 同上 |
| TC-AI-14 | `handleToggleAiPatchVisibility` | 任一 patch | 调用 | visible 字段翻转 | 仅目标 patch 改变 |
| TC-AI-15 | 预计算副作用 | activeSubMask.type === 'ai-subject' 且 selectedImagePath 已设置 | useEffect 触发 | 调用 `precompute_ai_subject_mask` 命令 | 失败仅 console.error 不抛 |

**验收标准(模块级)**:
- 全部 11 个导出函数在 selectedImage.path 为空时立即 return 不抛错。
- 切图保护(startPath 比对)覆盖全部带 invoke 的函数。
- AI 命令名与后端 `#[tauri::command]` 函数名(或 Invokes 常量)严格一致。

---

## 7. 后端 mask_generation.rs

涉及代码:[mask_generation.rs](file:///workspace/src-tauri/src/mask_generation.rs)。

### 7.1 数据结构反序列化

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-RUST-01 | `SubMaskMode` 序列化 | 无 | 序列化 Additive/Subtractive/Intersect | 输出 "additive"/"subtractive"/"intersect" | `camelCase` rename 生效,与前端 SubMaskMode 字符串一致 |
| TC-RUST-02 | `SubMask` 默认 opacity | 无 | 反序列化缺少 opacity 字段 | opacity = 100.0 | `default_opacity` 生效 |
| TC-RUST-03 | `MaskDefinition.requires_warped_image` | 含 color 子蒙版 | 调用 | true | 含 luminance 同样 true,其他 false |
| TC-RUST-04 | `LinearMaskParameters` 默认 | 反序列化空对象 | 调用 | range=50.0、feather=0.5 | 与前端 `createSubMask(Mask.Linear)` 默认值一致 |
| TC-RUST-05 | `ParametricMaskParameters` 默认 | 同上 | 调用 | tolerance=20.0、feather=35.0、其余 0/false | 与前端 `SUB_MASK_CONFIG[Mask.Color]` 默认值一致 |
| TC-RUST-06 | `BrushLine` 默认 | 同上 | 调用 | feather=0.5、opacity=1.0 | 与前端 BrushSettings 默认一致 |
| TC-RUST-07 | `FlowLine` 默认 | 同上 | 调用 | flow=10.0 | 与前端 `createSubMask(Mask.Flow).parameters.flow` 一致 |

### 7.2 单蒙版生成函数

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-RUST-08 | `generate_all_bitmap` | 无 | 调用 (10,10) | 全 255 的 10x10 GrayImage | 所有像素 === 255 |
| TC-RUST-09 | `generate_radial_bitmap` 中心 | params: 中心(5,5)、半径(5,5)、feather=0 | 调用 (11,11) | 中心像素 === 255,边角像素 === 0 | 距离 <= inner_bound 时 intensity=1.0 |
| TC-RUST-10 | `generate_radial_bitmap` 旋转 | rotation=90 | 调用 | 椭圆方向旋转,中心强度不变 | cos/sin 应用正确 |
| TC-RUST-11 | `generate_linear_bitmap` 零向量 | start==end | 调用 | 返回全 0 蒙版 | `len_sq < 0.01` 早退 |
| TC-RUST-12 | `generate_linear_bitmap` 渐变 | start=(0,5)、end=(10,5)、range=10 | 调用 (11,11) | 第 0 行 intensity=1.0 → 第 10 行 intensity=0.0 | 单调递减 |
| TC-RUST-13 | `generate_brush_bitmap` 空笔迹 | lines=[] | 调用 | 全 0 蒙版 | 跳过空 line |
| TC-RUST-14 | `generate_brush_bitmap` 单点 | 单点 + radius=5 | 调用 | 该点像素 === 255,外圈衰减 | 单点分支生效 |
| TC-RUST-15 | `generate_brush_bitmap` 橡皮 | tool='eraser' + 已有蒙版 | 调用 | 橡皮覆盖区域被减去 | `dst_val * (1 - src_val * opacity)` |
| TC-RUST-16 | `generate_flow_bitmap` 流量叠加 | flow=50,同一笔多次叠加 | 调用 | 累积不超过 255 | `c_norm + d - c_norm * d` 饱和 |
| TC-RUST-17 | `generate_color_bitmap` 无 warped | warped_image=None | 调用 | 返回 None | 上游 `resolve_warped_image_for_masks` 决定 |
| TC-RUST-18 | `generate_color_bitmap` 容差匹配 | warped 全红,target 红色,tolerance=20 | 调用 | 全部像素 === 255 | `dist_sq <= tolerance_sq` |
| TC-RUST-19 | `generate_color_bitmap` 越界 target | target_x = -1 | 调用 | 返回 None | 早退保护 |
| TC-RUST-20 | `generate_luminance_bitmap` 阈值匹配 | warped 全灰 luma≈128,target 同色 | 调用 | 命中区域 === 255 | `dist <= tolerance_val` |
| TC-RUST-21 | `generate_luminance_bitmap` 越界 | target 越界 | 调用 | 返回 None | 同 TC-RUST-19 |
| TC-RUST-22 | `generate_ai_bitmap_from_base64` 空尺寸 | width=0 或 height=0 | 调用 | 返回 Some(空 GrayImage) | 早退保护 |
| TC-RUST-23 | `generate_ai_bitmap_from_base64` 解码失败 | data_url 非法 | 调用 | 返回 None | `.ok()?` 链不 panic |
| TC-RUST-24 | `generate_ai_depth_bitmap` smoothstep | depth map 已知,min_depth=20、max_depth=80 | 调用 | 像素在 [min_depth, max_depth] 区间为非零,外区间为 0 | bandpass 行为正确 |
| TC-RUST-25 | `generate_sub_mask_bitmap` 不可见 | sub_mask.visible=false | 调用 | 返回 None | 早退 |
| TC-RUST-26 | `generate_sub_mask_bitmap` 未知 type | mask_type='unknown' | 调用 | 返回 None | `_` 分支兜底 |
| TC-RUST-27 | brush/clone/heal/liquify/retouch 共用 | 同一 params | 调用 | 5 种类型走同一 `generate_brush_bitmap` | match 分支正确 |

### 7.3 复合蒙版合成

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-RUST-28 | `generate_mask_bitmap` 空子蒙版 | sub_masks=[] | 调用 | 返回 None | 不渲染 |
| TC-RUST-29 | Additive 合成 | 两个 all 子蒙版,opacity=100 | 调用 | 取 max → 全 255 | `pixel.max(sub_pixel)` |
| TC-RUST-30 | Subtractive 合成 | 全 255 主 + 全 255 子 | 调用 | 全 0 | `saturating_sub` |
| TC-RUST-31 | Intersect 合成 | 全 255 主 + 全 0 子 | 调用 | 全 0 | `pixel.min(sub_pixel)` |
| TC-RUST-32 | invert 反选 | mask_def.invert=true | 调用 | 255 - 原值 | 末尾翻转 |
| TC-RUST-33 | opacity 缩放 | mask_def.opacity=50 | 调用 | 像素值 *= 0.5 | clamp 在 [0,255] |
| TC-RUST-34 | sub_mask.invert | sub_mask.invert=true | 调用 | 子蒙版先翻转再合成 | 在合成循环内 |
| TC-RUST-35 | sub_mask.opacity | sub_mask.opacity=50 | 调用 | 子蒙版先 *= 0.5 再合成 | 在合成循环内 |

### 7.4 缓存与覆盖

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-RUST-36 | `get_cached_or_generate_mask` 命中 | 第二次相同 def | 调用 | 直接返回 cache,不重新生成 | hash key 一致 |
| TC-RUST-37 | `get_cached_or_generate_mask` 未命中 | 第一次 | 调用 | 生成并写入 cache | cache.len 增加 |
| TC-RUST-38 | cache 容量上限 | 已有 50 条 | 调用 | cache.clear() 后重写 | 防止内存膨胀 |
| TC-RUST-39 | `resolve_warped_image_for_masks` 不需要 | masks 不含 color/luminance | 调用 | 返回 None | 不浪费资源 |
| TC-RUST-40 | `generate_mask_overlay` 返回 data url | 任意有效 mask_def | 调用 | 返回 `data:image/png;base64,...` | PNG 可被 image::load 解码 |
| TC-RUST-41 | `generate_mask_overlay` 空 | mask_def 不可见 | 调用 | 返回空串 | 前端可判空跳过渲染 |

### 7.5 形态学辅助函数

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-RUST-42 | `grayscale_dilate` | 5x5 中心一个 255 像素,k=2 | 调用 | 形成 5x5 全 255 块 | max filter 正确 |
| TC-RUST-43 | `grayscale_erode` | 5x5 中心一个 0 像素,k=2 | 调用 | 形成 5x5 全 0 块 | min filter 正确 |
| TC-RUST-44 | `apply_grow_and_feather` grow>0 | 全 0 中心一个 255 | 调用 | 区域扩张 | dilate 分支 |
| TC-RUST-45 | `apply_grow_and_feather` grow<0 | 全 255 中心一个 0 | 调用 | 0 区域扩张 | erode 分支 |
| TC-RUST-46 | `apply_grow_and_feather` feather | grow=0, feather=10 | 调用 | 边缘软化 | sigma > 0.01 才 blur |
| TC-RUST-47 | `apply_grow_and_feather` decontaminate | decontaminate=50 | 调用 | 边缘锐化,核心区不变 | transition_weight 仅在 0.5 附近生效 |
| TC-RUST-48 | `stroke_bounds` 越界 | points 全部在画布外 | 调用 | 返回 None | 早退 |
| TC-RUST-49 | `stroke_bounds` 单点 | 一个点 | 调用 | 返回非 None 的 bbox | 单点分支 |
| TC-RUST-50 | `render_stroke_layer_parallel` 空笔迹 | points=[] | 调用 | 返回全 0 | radius<=0 早退 |

**验收标准(模块级)**:
- 全部 50 个用例通过 `cargo test --lib`。
- 不依赖 GPU、不依赖 AI 模型文件。
- 形态学函数对边界条件(空图像、k=0)不 panic。

---

## 8. 后端 color_range_mask.rs

涉及代码:[color_range_mask.rs](file:///workspace/src-tauri/src/color_range_mask.rs)。

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-COLOR-01 | `ColorRangeSettings::default_select_red` | 无 | 调用 | hue_center=0、hue_tolerance=15、min_saturation=0.3、max_saturation=1.0、min_value=0.15、max_value=1.0、feather=10、invert=false | 与文档一致 |
| TC-COLOR-02 | `rgb_to_hsv` 红色 | (1,0,0) | 调用 | (0, 1, 1) | 红色 hue=0 |
| TC-COLOR-03 | `rgb_to_hsv` 绿色 | (0,1,0) | 调用 | (120, 1, 1) | 绿色 hue=120 |
| TC-COLOR-04 | `rgb_to_hsv` 蓝色 | (0,0,1) | 调用 | (240, 1, 1) | 蓝色 hue=240 |
| TC-COLOR-05 | `rgb_to_hsv` 灰色 | (0.5,0.5,0.5) | 调用 | sat=0 | 灰色无饱和度 |
| TC-COLOR-06 | `hue_distance` 环绕 | 359 与 1 | 调用 | 2 | 处理 0/360 环绕 |
| TC-COLOR-07 | `hue_distance` 普通 | 100 与 50 | 调用 | 50 | 直接差 |
| TC-COLOR-08 | `generate_raw_mask` 全红图 | 全红图 + select_red | 调用 | 全 255 | 红色命中 |
| TC-COLOR-09 | `generate_raw_mask` 全绿图 | 全绿图 + select_red | 调用 | 全 0 | hue 不匹配 |
| TC-COLOR-10 | `generate_raw_mask` invert | 全绿图 + select_red + invert=true | 调用 | 全 255 | 反选生效 |
| TC-COLOR-11 | `gaussian_blur_gray` sigma=0 | sigma<0.5 | 调用 | 返回原 mask | 早退 |
| TC-COLOR-12 | `gaussian_blur_gray` sigma=1 | 中心 255 周围 0 | 调用 | 中心扩散 | kernel 归一化 |
| TC-COLOR-13 | `generate_mask` feather clamp | feather=10000 + 1x1 图 | 调用 | sigma 被 clamp 到 max_sigma=0.25 | `min(w,h)/4` 上限 |
| TC-COLOR-14 | `generate_color_range_mask_command` 落盘 | 临时图 + 临时输出路径 | 调用 | 输出文件存在且为 GrayImage | 命令签名可被 invoke |

**验收标准(模块级)**:
- HSV 转换对 RGB 边界值(0/1)不产生 NaN。
- 高斯模糊 kernel 归一化(sum=1)。
- `invert` 字段同时影响 raw_mask 与最终输出。

---

## 9. 后端 luminance_range_mask.rs

涉及代码:[luminance_range_mask.rs](file:///workspace/src-tauri/src/luminance_range_mask.rs)。

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-LUM-01 | `select_shadows` | 无 | 调用 | min=0、max=0.35、bandwidth=0.05、feather=12 | 与文档一致 |
| TC-LUM-02 | `select_highlights` | 无 | 调用 | min=0.65、max=1.0 | 与文档一致 |
| TC-LUM-03 | `select_midtones` | 无 | 调用 | min=0.3、max=0.7 | 与文档一致 |
| TC-LUM-04 | `compute_luminance` 白色 | (1,1,1) | 调用 | ≈ 1.0 | OKLab 近似 |
| TC-LUM-05 | `compute_luminance` 黑色 | (0,0,0) | 调用 | ≈ 0.0 | 同上 |
| TC-LUM-06 | `compute_luminance` 中灰 | (0.5,0.5,0.5) | 调用 | ≈ 0.5 | 单调 |
| TC-LUM-07 | `smoothstep` 边界 | e0=0、e1=1、x=0.5 | 调用 | ≈ 0.5 | smoothstep 性质 |
| TC-LUM-08 | `smoothstep` 越界 | x=-1 | 调用 | 0 | clamp 生效 |
| TC-LUM-09 | `generate_raw_mask` 阴影选择 | 全黑图 + select_shadows | 调用 | 全 255 | 黑色命中阴影 |
| TC-LUM-10 | `generate_raw_mask` 高光选择 | 全黑图 + select_highlights | 调用 | 全 0 | 黑色不在高光 |
| TC-LUM-11 | `generate_raw_mask` 中间调带宽 | bandwidth=0.1 + 边界值 | 调用 | 边界处 smoothstep 过渡 | 软过渡而非硬切 |
| TC-LUM-12 | `generate_raw_mask` invert | 全黑图 + select_highlights + invert | 调用 | 全 255 | 反选生效 |
| TC-LUM-13 | `generate_mask` feather | feather=5 | 调用 | 输出经高斯模糊 | 复用 color_range_mask::gaussian_blur_gray |
| TC-LUM-14 | `generate_luminance_range_mask_command` 落盘 | 临时图 + 临时输出 | 调用 | 文件存在 | 命令可被 invoke |

**验收标准(模块级)**:
- OKLab 近似亮度对纯色不产生 NaN。
- bandwidth 提供软过渡,过渡区像素值在 (0, 255) 之间。
- 复用 color_range_mask 的高斯模糊实现(避免重复实现漂移)。

---

## 10. 跨模块 / 横切关注点

| 用例 ID | 模块 | 前置条件 | 步骤 | 预期结果 | 验收标准 |
|--------|------|---------|------|---------|---------|
| TC-CROSS-01 | 前后端类型字符串一致性 | 无 | 对照 `Mask` 枚举与 `sub_mask.mask_type` 字符串 | 17 个值完全一致 | 防止前后端类型不匹配导致蒙版不渲染 |
| TC-CROSS-02 | SubMaskMode 字符串一致 | 无 | 对照前端与后端 | additive/subtractive/intersect | 防止合成模式错乱 |
| TC-CROSS-03 | i18n key 完备 | 无 | 对照 zh-CN.json 与 en.json 的 masks 段 | key 集合完全一致 | `npm run i18n:check` 通过 |
| TC-CROSS-04 | 默认值一致性 | 无 | 对照前端 `createSubMask` / `SUB_MASK_CONFIG` 与后端 `default_*` | 全部一致 | 防止参数漂移 |
| TC-CROSS-05 | 错误不 panic | 无 | 后端任意函数传入非法 JSON | 走 `unwrap_or_default` / `?` 链不 panic | `anyhow::Result` 传播错误 |
| TC-CROSS-06 | 性能基准 | 1000x1000 图 + 全红 + select_red | 调用 `generate_mask` | < 100ms(CPU 单线程基线) | rayon 并行生效 |
| TC-CROSS-07 | 缓存命中性能 | 同一 mask_def 二次调用 | 调用 `get_cached_or_generate_mask` | < 1ms | hash 命中 |
| TC-CROSS-08 | AI 命令名一致 | 无 | 对照 `Invokes` 常量与后端 `#[tauri::command]` 名 | 全部匹配 | 防止 invoke 找不到命令 |

---

## 11. 测试执行说明

### 11.1 前端
```bash
npm install                         # 安装 vitest/@testing-library 等 devDeps
npm run test                         # 跑全部 *.test.ts/tsx
npm run test:coverage                # 输出覆盖率报告
```
- 测试文件位置:`tests/frontend/**/*.test.tsx`
- setup:`tests/frontend/setup.ts`(mock `@tauri-apps/api/core`、`@clerk/react`)

### 11.2 后端
```bash
cd src-tauri
cargo test --lib                     # 跑 lib 目标,无需 Tauri runtime
cargo test --lib -- --nocapture      # 打印 println!
cargo test --lib mask_generation     # 仅跑 mask_generation 模块
```
- 测试位置:`src-tauri/src/*.rs` 内 `#[cfg(test)] mod tests {}` 块

### 11.3 验收门禁
- 所有 TC-* 用例 100% 通过
- 前端覆盖率:蒙版相关文件 lines ≥ 80%
- 后端覆盖率:mask_generation/color_range_mask/luminance_range_mask lines ≥ 85%
- CI 在 PR 上自动跑两端测试,失败阻塞合并

---

## 附录:用例与代码位置映射表

| 模块 | 代码位置 | 用例 ID 前缀 |
|------|---------|------------|
| 面板分区 | MasksPanel.tsx L1089-L1122 | TC-PANEL-* |
| Mask 枚举 | Masks.tsx L26-L110 | TC-MASK-* |
| createSubMask | maskUtils.ts | TC-CREATE-* |
| SUB_MASK_CONFIG | MasksPanel.tsx L97-L156 | TC-CONFIG-* |
| MaskEditingToolbar | MaskEditingToolbar.tsx | TC-TB-* |
| useAiMasking | useAiMasking.ts | TC-AI-* |
| mask_generation | mask_generation.rs | TC-RUST-* |
| color_range_mask | color_range_mask.rs | TC-COLOR-* |
| luminance_range_mask | luminance_range_mask.rs | TC-LUM-* |
| 跨模块 | - | TC-CROSS-* |
