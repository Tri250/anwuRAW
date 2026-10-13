// W9-I1: useProcessStore 合成处理状态机竞态测试
// 双入口（动作入口 / 事件入口）单数据流收敛验证：
//   - beginCompose 返回单调递增 epoch
//   - 旧 epoch 的迟到事件（track/settle）按 epoch 丢弃
//   - 已落账（done/error）或已重置（idle）后的一切旧事件被 phase 守卫丢弃
//   - 保存失败允许 done → error（不可被迟到的完成事件逆转）
import { beforeEach, describe, expect, it } from 'vitest';
import { useProcessStore } from '../../src/store/useProcessStore';

const store = () => useProcessStore.getState();

beforeEach(() => {
  // 每个 case 从干净状态开始（resetCompose 使旧 epoch 全部失效）
  (['panorama', 'hdr', 'focusStack', 'multiExposure'] as const).forEach((k) => store().resetCompose(k));
});

describe('composeRuns 状态机（W9-I1）', () => {
  it('初始为 idle，beginCompose 进入 processing 并返回递增 epoch', () => {
    expect(store().composeRuns.panorama.phase).toBe('idle');

    const e1 = store().beginCompose('panorama', 'Starting...');
    const e2 = store().beginCompose('panorama');
    expect(e2).toBeGreaterThan(e1);

    expect(store().composeRuns.panorama).toMatchObject({
      phase: 'processing',
      message: null,
      error: null,
    });
  });

  it('进度消息在 processing 态被记录（事件入口 epoch=null 仅 phase 守卫）', () => {
    const epoch = store().beginCompose('panorama');
    store().trackComposeMessage('panorama', null, 'Stitching 1/3...');
    expect(store().composeRuns.panorama.message).toBe('Stitching 1/3...');
    expect(store().composeRuns.panorama.phase).toBe('processing');
    expect(epoch).toBeGreaterThan(0);
  });

  it('迟到的旧 epoch 事件被丢弃（双入口竞态核心场景）', () => {
    const e1 = store().beginCompose('panorama');
    store().composeSettled('panorama', e1, { finalMessage: null }); // 第一轮完成

    const e2 = store().beginCompose('panorama'); // 第二轮开始
    // 旧一轮（e1）的迟到失败事件必须被丢弃，不得污染第二轮
    store().composeSettled('panorama', e1, { error: 'late failure from run 1' });
    expect(store().composeRuns.panorama.phase).toBe('processing');
    expect(store().composeRuns.panorama.error).toBeNull();

    store().trackComposeMessage('panorama', e1, 'late message from run 1');
    expect(store().composeRuns.panorama.message).toBeNull();

    // 当前轮事件正常生效
    store().trackComposeMessage('panorama', e2, 'Stitching 2/3...');
    expect(store().composeRuns.panorama.message).toBe('Stitching 2/3...');
    store().composeSettled('panorama', e2, { finalMessage: null });
    expect(store().composeRuns.panorama.phase).toBe('done');
  });

  it('落账后一切旧事件被 phase 守卫丢弃（progress/complete 迟到）', () => {
    store().beginCompose('hdr');
    store().composeSettled('hdr', null, { finalMessage: 'Hdr Ready' });
    expect(store().composeRuns.hdr.phase).toBe('done');

    // 迟到的进度与完成事件不得改写 done 态
    store().trackComposeMessage('hdr', null, 'late progress');
    expect(store().composeRuns.hdr.message).toBe('Hdr Ready');
    store().composeSettled('hdr', null, { finalMessage: 'Hdr Ready' });
    expect(store().composeRuns.hdr.phase).toBe('done');

    // done 态后的 error 视为保存失败覆盖（save 失败走同一入口），这是有意语义；
    // 迟到的完成事件仍不可把 error/done 态逆转回 processing 或改写。
    store().composeSettled('hdr', null, { error: 'save failed' });
    expect(store().composeRuns.hdr.phase).toBe('error');
    store().composeSettled('hdr', null, { finalMessage: 'Hdr Ready' });
    expect(store().composeRuns.hdr.phase).toBe('error');
  });

  it('resetCompose 后模态关闭，一切旧事件不复活状态', () => {
    const epoch = store().beginCompose('focusStack');
    store().resetCompose('focusStack');
    expect(store().composeRuns.focusStack.phase).toBe('idle');

    store().trackComposeMessage('focusStack', null, 'late progress');
    store().composeSettled('focusStack', epoch, { finalMessage: null });
    store().composeSettled('focusStack', null, { error: 'late error' });
    expect(store().composeRuns.focusStack.phase).toBe('idle');
    expect(store().composeRuns.focusStack.error).toBeNull();
  });

  it('invoke 失败（动作入口带 epoch）落账 error；保存失败可 done → error', () => {
    const epoch = store().beginCompose('panorama');
    store().composeSettled('panorama', epoch, { error: 'boom' });
    expect(store().composeRuns.panorama.phase).toBe('error');
    expect(store().composeRuns.panorama.error).toBe('boom');

    // 保存失败把 error 态的 message 清空并保持 error（允许 error/error）
    store().composeSettled('panorama', null, { error: 'save failed' });
    expect(store().composeRuns.panorama.error).toBe('save failed');
  });

  it('保存失败覆盖 done 态（done → error 单向，不可被完成事件逆转）', () => {
    store().beginCompose('hdr');
    store().composeSettled('hdr', null, { finalMessage: 'Hdr Ready' });
    store().composeSettled('hdr', null, { error: 'save failed' });
    expect(store().composeRuns.hdr.phase).toBe('error');

    store().composeSettled('hdr', null, { finalMessage: 'Hdr Ready' });
    expect(store().composeRuns.hdr.phase).toBe('error');
  });

  it('四模态互不串扰（multiExposure 协议预留位可用）', () => {
    store().beginCompose('panorama');
    store().beginCompose('hdr');
    store().beginCompose('focusStack');
    const e = store().beginCompose('multiExposure');

    store().composeSettled('multiExposure', e, { error: 'x' });
    expect(store().composeRuns.multiExposure.phase).toBe('error');
    expect(store().composeRuns.panorama.phase).toBe('processing');
    expect(store().composeRuns.hdr.phase).toBe('processing');
    expect(store().composeRuns.focusStack.phase).toBe('processing');
  });
});
