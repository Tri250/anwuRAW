import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/frontend/setup.ts'],
    include: ['tests/frontend/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        // 调整
        'src/components/adjustments/**/*.{ts,tsx}',
        'src/components/panel/right/ControlsPanel.tsx',
        'src/utils/adjustments.ts',
        'src/utils/masterRecipes.ts',
        // 裁剪与变换
        'src/components/panel/right/CropPanel.tsx',
        'src/components/modals/TransformModal.tsx',
        'src/components/modals/LensCorrectionModal.tsx',
        'src/utils/cropUtils.ts',
        // 蒙版
        'src/components/panel/right/Masks.tsx',
        'src/components/panel/right/MasksPanel.tsx',
        'src/components/panel/editor/MaskEditingToolbar.tsx',
        'src/utils/maskUtils.ts',
        'src/hooks/useAiMasking.ts',
        // 图像修复
        'src/components/panel/right/AIPanel.tsx',
        // 预设
        'src/components/panel/right/PresetsPanel.tsx',
        'src/components/modals/ConfigurePresetModal.tsx',
        'src/components/modals/CreateFolderModal.tsx',
        'src/components/modals/RenameFolderModal.tsx',
        'src/hooks/usePresets.ts',
        // 导出
        'src/components/panel/right/ExportPanel.tsx',
        'src/components/ui/ExportPresetsList.tsx',
        'src/components/ui/ExportImportProperties.tsx',
        'src/components/ui/ImagePicker.tsx',
        'src/hooks/useExportSettings.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
});
