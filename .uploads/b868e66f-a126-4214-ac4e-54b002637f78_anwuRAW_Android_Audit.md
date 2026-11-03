# anwuRAW · Android 端全量深度审计报告（v2.1.3）

> 审计对象：`Tri250/anwuRAW`（RapidRAW 的本地化定制分支，含蒙版/移动端 Crystal 增强）
> 审计范围：Release **v2.1.3**（`main` HEAD `a5d776a`）Android 端 Runtime + UI/UX
> 审计维度：① 用户交互体验 ② 功能缺陷 ③ 操作链路
> 基准参照：国内同类水准 —— **Lightroom Mobile、醒图（醒图）、美图秀秀、泼辣修图、Snapseed**

---

## 0. 版本与运行现实（必读前提）

| 项 | 结论 |
|----|------|
| 用户所述 `v2.1.13` | **仓库不存在该标签**。最新发布标签为 `v2.1.3`，即 `main` 当前 HEAD，本次据此审计。 |
| Android 构建状态 | 提交 `fix(release): Drop Android from CI/release matrices (signing secrets and ONNX Runtime Android libs are not configured)` 表明：**Android 已从 CI/Release 矩阵移除**，仅保留 `build.yml` 供自建；Android 包为侧载/手动构建。 |
| **端侧 AI 可用性（关键）** | 仓库既有审计（`functional-modules-audit.md` 第 32、41 条）明确：ONNX Runtime Android 库**未打包进 APK**。因此所有依赖端侧模型的 feature 在 Android 真机**运行时必失败**。 |
| 真机验证缺口 | 既有审计第 534 条自承："沙箱无 Android 真机/模拟器……未做真机启动与导出回归"。**即 UI/UX 的真实交互从未在真机验证**——本审计正是补此缺口。 |

**由此导出的核心事实**：移动端 `CrystalMobileApp` 的「人像」「AI 工具」两大分类（眼部增强、背景虚化、天空/主体识别、AI 一键增强、AI 降噪）在 Android 上**入口照常展示、点击即 toast 报错**，是贯穿三大维度的最高级别问题。

---

## 1. 既有基线（已达成的优点，先肯定）

为避免"为改而改"，先确认已具备的国内水准要素：

- **设计系统化**：`src/crystal.css` 定义了完整的 Design Token（暗色基底、`--cx-gold`/`--cx-teal` 双流程强调色、分类色、安全区 `env(safe-area-inset-*)`），不污染桌面视图。
- **触屏优先的组件**：滑杆 `CrystalRangeSlider` 触点 36px、开关 46×26px、输入框 44px，基本满足 44px 最小触控规范。
- **横屏降级**：`@media (orientation: landscape)` 编辑域改为左右双栏网格，符合平板/折叠屏习惯。
- **本地化完整**：`zh-CN.json` 中 Crystal 全部 30 个关键文案键**全部到位**（原图/对比/撤销/重置/导出/各类滤镜名等均已中文化）。
- **可访问性雏形**：顶栏图标按钮带 `aria-label`，AI 识别有 `cx-busy-overlay` 进度蒙层，重置有 `ConfirmModal` 二次确认。
- **导航语义清晰**：编辑域/导出域用 `data-flow` 区分，返回层级（导出→编辑→图库）逻辑存在。

> 结论：该项目**不是"粗劣原型"，而是具备专业骨架**。差距集中在"真机交互细节""AI 可达性""术语与心智模型一致性"三处，修补后可达国内主流水准。

---

## 2. 维度一 · 用户交互体验

| # | 严重度 | 问题 | 证据 | 国内基准对比 | 改善方案 |
|---|--------|------|------|--------------|----------|
| UX-1 | **P1** | **AI 核心能力在 Android 不可达却照常展示**：人像/AI 两大分类入口正常，点击即失败，体验断裂 | `CrystalAiToolsPanel.tsx` / `CrystalCategoryPanel.tsx` 的 `runEyeEnhance`/`runBgBlur`/`runSky`/`runSubject`；既有审计 #32 | 醒图/美图全量本地 AI 可用 | ① 启动期探测 `ONNX` 能力，不可用时**入口置灰 + "本设备暂不支持"角标**；② 或在发布前补齐 Android ONNX 库（既有审计 #41 已有取库方案）；③ 失败 toast 改为**可重试 + 引导** |
| UX-2 | **P1** | **预览区无缩放/平移**：`.cx-preview img` 设 `pointer-events:none` 且仅为 `object-fit:contain` 静态图，无法放大查细节 | `crystal.css:143-148`；`CrystalMobileApp.tsx:97` | 所有修图 App 均支持双指缩放+拖动 | 引入 `pointer-events:auto` 的 `transform` 缩放层（双指 pinch + 单指拖移 + 双击 1:1），与 Lightroom Mobile 一致；导出域预览同样支持 |
| UX-3 | **P2** | **"原图"与"对比"语义重合**：底栏 + 预览浮层各一对，二者**都只切 `showOriginal`**，功能无差别 | `CrystalMobileApp.tsx:91-108`（两个 `useShowOriginalHold`）；`crystal.css:869-894` | 真正的对比应是 hold-to-compare，或分屏滑杆 | 合并为**单一"按住对比"手势**（预览浮层一处即可）；新增**分屏对比滑块**（拖动分隔线看原图/成片），呼应 Snapseed/Lightroom |
| UX-4 | **P2** | **同一屏重复放置撤销/重做**：顶栏 `CrystalTopBar` 与底栏 `CrystalBottomBar` 各一套 undo/redo，浪费空间、信息冗余 | `CrystalMobileApp.tsx:62-67` vs `:153-164` | 移动端通常只保留一处 | 仅保留**底栏**撤销/重做；顶栏"撤销/重做"改为"信息/帮助"或移除 |
| UX-5 | **P2** | **"保存/导出"术语混乱**：编辑顶栏 CTA 写"保存"实际跳导出；导出域 CTA 写"导出"，成功提示"已保存到相册" | `CrystalMobileApp.tsx:72`（`cx-save-pill`→`setFlow('export')`）；`WatermarkExportPage.tsx:135,424` | 国内 App 明确区分"应用/保留"与"导出/分享" | 编辑页 CTA 改为"**下一步/导出**"或"完成"；或拆为"保留修改（侧车自动）+ 导出"两入口，消除"我还没保存"焦虑 |
| UX-6 | **P2** | **缺少触觉反馈（Haptic）**：按钮仅 `:active` 变色，长按时无 `navigator.vibrate` 轻震 | 全部 `crystal.css` 的 `:active`；无 `vibrate` 调用 | 国内 App 普遍有轻震 | 在 tile/分类切换/长按对比/导出成功处加 `navigator.vibrate(8~12)`（Android WebView 支持） |
| UX-7 | **P3** | **分类配色重复**：`--cx-cat-filter:#f5c842` 与预设同为金，导航中"预设"和"滤镜"颜色相同难区分 | `crystal.css:24-30` | 分类色应可辨识 | 滤镜改用独立色（如品红/青蓝），与预设金区分 |
| UX-8 | **P3** | **对比反馈单一**：仅 hold-to-compare，无 A/B 快速切换、无"前后并排" | 仅 `useShowOriginalHold` | Lightroom/Snapseed 支持分屏 | 见 UX-3 分屏对比 |
| UX-9 | **P3** | **无障碍对比度**：`--cx-faint:#6f6f64` 在 `--cx-page:#0b0b09` 上对比度偏低，hint 小字可能不达 WCAG AA；`cx-chip`/`cx-thumb-card`/`cx-tile` 缺 `aria-label` | `crystal.css:17,639-642` | AA 4.5:1 | 提亮 `--cx-faint` 至 ≥ `#8a8a7d`；为图标类按钮补 `aria-label` |
| UX-10 | **P3** | **流程切换无过渡**：`data-flow` 编辑↔导出切换瞬间强调色（金↔青绿）无动画，略生硬 | `crystal.css:44-47` | 国内 App 转场顺滑 | 给 `.cx-app` 加 `transition` 或入场动画；导出域卡片加 `fade/slide` |

---

## 3. 维度二 · 功能缺陷

| # | 严重度 | 问题 | 证据 | 影响 | 改善方案 |
|---|--------|------|------|------|----------|
| FD-1 | **P0** | **Android 返回键与 Crystal 内 ConfirmModal 冲突**：`useAndroidBackHandler` 先 `popExitLayer()` 返回 `true`，导致全局弹窗关闭逻辑（含 `confirmModalState`）**永不触发**；在"重置"确认弹窗打开时按返回 → 不走关闭弹窗，而是 `onBackToLibrary()` 跳回图库，弹窗随卸载消失，用户误以为"已取消"实则被踢出编辑页 | `useAndroidBackHandler.ts:14`（`if (popExitLayer()) return;`）先于 `:18` 的 `confirmModalState`；`CrystalMobileApp.tsx:213-229` 的 handler 只处理 showOriginal/flow/library | 弹窗场景下返回键行为错误，丢失编辑上下文 | ① 在 Crystal 的 exit-layer handler 中**优先判断 `useUIStore.confirmModalState.isOpen`**，打开时关闭弹窗并返回（不跳库）；② 或让 `popExitLayer` 在调用前允许"拦截型"overlay 先消费 |
| FD-2 | **P0/P1** | **端侧 AI 运行时必失败且无降级**（同 UX-1）：UI 无能力预检、无置灰、仅 toast 报错 | `CrystalAiToolsPanel.tsx` 各 `run*` 的 `catch → toast.error`；既有审计 #32 | "人像""AI 工具"两大分类在 Android 近乎失效 | 启动期探测 + 入口置灰 + 引导（见 UX-1） |
| FD-3 | **P1** | **多指触控下 `showOriginal` 残留风险**：`useShowOriginalHold` 用 `holdActive` ref，若同时按"原图"(delay=0)+"对比"两按钮，两个 timer 都置 `true`，快速释放一个后另一个仍持有时不会复位 | `crystalShared.tsx:240-282` | 预览卡在"显示原图"态 | 全局仅保留**单一对比手势**接管；或用全局单例状态而非 per-button ref |
| FD-4 | **P1** | **预设强度拖动污染撤销栈**：`handleIntensity` 连续拖动每档都 `setAdjustments` 走 debounced `pushHistory`，撤销时一档一档回退，体验差 | `CrystalPresetsPanel.tsx:401-409` + `useCrystalAdjust.applyPresetObject` | 撤销粒度过细，用户需连点多次 | 拖动态**合并为一次历史**（拖动结束 commit 一次），与桌面/泼辣一致 |
| FD-5 | **P2** | **导出后无分享/打开**：仅 `toast("已保存到相册")`，无系统分享/微信/微博入口 | `WatermarkExportPage.tsx:135,194-216`（调 `ExportImages` 经 MediaStore） | 移动端核心诉求"修完即分享"无法满足 | 成功后弹**分享浮层**：系统分享 `Intent.ACTION_SEND`（`@tauri-apps/plugin-share` 或自写） / 微信 / 保存副本 |
| FD-6 | **P2** | **导出文件名强制 `_crystal` 后缀**：与模板无关、用户不可改；PNG 忽略画质档但未在 UI 说明 | `WatermarkExportPage.tsx:155-191` | 用户困惑、不可控 | 允许自定义后缀/前缀；PNG 时隐藏或禁用画质档并标注"无损" |
| FD-7 | **P2** | **导出进行中系统返回"无反应"**：`CrystalMobileApp` handler `if (isExporting) return;` 消费返回却无任何提示，用户以为卡死 | `CrystalMobileApp.tsx:220-224`；`WatermarkExportPage.tsx:222` 仅靠 `disabled` | 焦虑、误判崩溃 | 导出中按返回 → 轻提示"导出进行中…"或允许后台继续+toast |
| FD-8 | **P3** | **横屏导出域未适配**：`@media landscape` 仅覆盖编辑域，导出域仍是纵向且预览固定 `max-height:46vh` | `crystal.css:835-867,621-626` | 平板上导出页浪费空间 | 导出域横屏改为左右栏（预览+参数） |
| FD-9 | **P3** | **预览首帧前空白**：仅 `hasRenderedFirstFrame` 后显示"渲染中…"，首帧前无骨架/占位 | `CrystalMobileApp.tsx:99` | 弱网/大图时黑屏焦虑 | 加**骨架屏/模糊缩略图占位**（复用 `originalPreview`） |

---

## 4. 维度三 · 操作链路

**主链路（现状）**：
```
图库选图 → 编辑域(7分类调参) → 顶栏"保存" → 导出域(模板/签名/格式/画质) → 导出CTA → MediaStore
```

| # | 严重度 | 问题 | 证据 | 改善方案 |
|---|--------|------|------|----------|
| OC-1 | **P1** | **"保存"≠保存**：CTA 命名"保存"实为"跳转导出"，而修改其实已自动落侧车；制造"我还没保存"焦虑 | `CrystalMobileApp.tsx:72` | 编辑页 CTA 改"**下一步·导出**"；明确"修改已自动保留"，导出为独立动作 |
| OC-2 | **P1** | **导出前无法对照原图**：导出域预览用 `finalPreviewUrl`（已编辑），无原图对照，用户导出前难确认效果 | `WatermarkExportPage.tsx:76-78,237` | 导出页预览支持 UX-3 的分屏对比；或加"显示原图"开关 |
| OC-3 | **P2** | **无批量/多选导出**：一次只导当前图 | `WatermarkExportPage.tsx:200-209`（单 path） | 支持"批量套用预设并导出"（移动端高频诉求） |
| OC-4 | **P2** | **成功后无引导**：仅文字提示，无"查看/分享/返回图库"三选一 | `WatermarkExportPage.tsx:439-443` | 成功浮层：查看 / 分享 / 返回图库 |
| OC-5 | **P2** | **首次启动引导错配**：`App.tsx:501` 弹桌面 `OnboardingModal`（含快捷键等），对移动用户无关甚至困惑 | `App.tsx:501-506` | 移动端专属引导：长按对比、滑动分类、双指缩放、导出水印 |
| OC-6 | **P3** | **预设应用状态不透明**：点缩略图应用、再点取消，仅靠 `is-active` 描边，无"当前已应用：XXX"状态条与移除入口 | `CrystalPresetsPanel.tsx:473-493` | 顶部加"已应用预设：XXX ✕"状态条，一键移除 |
| OC-7 | **P3** | **进入编辑无"对比/导出"同屏**：编辑与导出割裂为两个 flow，来回切换成本高 | 见 OC-1/OC-2 | 提供"导出浮层"而非整页跳转，保留编辑上下文 |

---

## 5. 优先级路线图（落地顺序）

| 优先级 | 项 | 预计收益 | 工作量 |
|--------|----|----------|--------|
| **P0** | FD-1 返回键与弹窗冲突 | 修复致命导航错误 | 小（逻辑修正） |
| **P0/P1** | UX-1 / FD-2 端侧 AI 可达性（探测+置灰 或 补 ONNX 库） | 恢复人像/AI 两大分类可用 | 中（补库）/ 小（置灰） |
| **P1** | UX-2 预览缩放/平移 | 达到修图 App 基础能力 | 中 |
| **P1** | UX-3 + OC-2 分屏对比 | 专业级前后对照 | 中 |
| **P1** | UX-5 / OC-1 术语与链路一致性 | 消除心智模型冲突 | 小 |
| **P1** | FD-4 撤销栈合并 | 拖动态一次历史 | 小 |
| **P2** | UX-4 去重撤销/重做、UX-6 Haptic、FD-5/OC-4 分享、OC-5 移动引导 | 体验细节补齐 | 中 |
| **P3** | UX-7/8/9/10、FD-6/7/8/9、OC-3/6/7 | 打磨与无障碍 | 中~大 |

---

## 6. 改善方案 · 关键重设计规格（可直接落地）

### 6.1 编辑器底栏（修正后）
- **移除顶栏撤销/重做**（UX-4）；底栏保留 6 键，但"原图/对比"合并为**单一"按住对比"**键（UX-3）。
- 新增"**缩放**"指示（双指图标），首屏引导提示一次（OC-5）。

### 6.2 预览区（修正后）
```css
/* 替代 crystal.css:143-148 —— 允许缩放/平移 */
.cx-preview-img { pointer-events: auto; touch-action: none; will-change: transform; }
/* 双指 pinch → transform: scale(); 单指拖移 → translate(); 双击 → 1:1 */
```
- 叠加快照骨架（FD-9）。

### 6.3 分屏对比（新增组件 `CxSplitCompare`）
- 一条可拖动分隔线，左原图 / 右成片（或反之），松手后可保持；同时保留"按住全屏对比"。

### 6.4 导出域（修正后）
- CTA 文案统一为"**导出**"；成功浮层三选一：**查看 / 分享 / 返回图库**（FD-5/OC-4）。
- 文件名可编辑前缀（FD-6）。
- 导出中按系统返回 → 轻提示而非静默（FD-7）。

### 6.5 返回键修复（核心补丁，伪代码）
```ts
// CrystalMobileApp 的 exit-layer handler 优先处理弹窗
const handler = () => {
  const ui = useUIStore.getState();
  if (ui.confirmModalState.isOpen) { ui.closeConfirm(); return; }   // FD-1
  if (useEditorStore.getState().showOriginal) { setEditor({showOriginal:false}); return; }
  if (flow === 'export') { if (isExporting) { toast('导出进行中…'); return; } setFlow('edit'); return; }
  onBackToLibrary();
};
```

---

## 7. 结论

anwuRAW Android 端（`CrystalMobileApp`）**已具备专业级的设计骨架与本地化**，差距不在"有没有"，而在"真机交互是否顺、AI 是否真能用、术语是否自洽"。最致命的三处是：

1. **FD-1 返回键与弹窗冲突**（P0，导航错误，需立即修）；
2. **端侧 AI 在 Android 不可达却照常展示**（P0/P1，割裂人像/AI 两大分类）；
3. **预览无缩放、对比方式冗余、保存/导出术语混乱**（P1，拉低专业感）。

按第 5 节路线图落地后，即可对齐 Lightroom Mobile / 醒图等国内主流水准。

---

### 附：本审计核验依据（已读取的真实代码/资源）
- `src/components/mobile/CrystalMobileApp.tsx`、`crystalShared.tsx`、`CrystalCategoryPanel.tsx`、`CrystalAiToolsPanel.tsx`、`CrystalPresetsPanel.tsx`、`WatermarkExportPage.tsx`
- `src/hooks/useAndroidBackHandler.ts`、`src/utils/androidBackRegistry.ts`、`src/App.tsx`
- `src/crystal.css`、`src/i18n/locales/zh-CN.json`（Crystal 章节 30 键全部命中）
- 仓库既有审计 `functional-modules-audit.md`（Android 专项 #32/#41/#534 等）、`crystal-mobile-improvement-plan.md`
- 远程引用核验：`git ls-remote` 确认最新标签为 `v2.1.3`（无 `v2.1.13`）

> 如需，我可继续把第 6 节的"修正后编辑器/导出页"产出为**高保真可交互 HTML/CSS 原型**（含 pinch-zoom、分屏对比、修正返回逻辑的真实演示），以及一份配套的 `DESIGN.md` 移动设计规范。
