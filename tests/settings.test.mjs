/**
 * 配置持久化回归测试：直接验证生产快捷键解析器的保存/读取一致性。
 * 不访问用户 SQLite；真实界面及数据库测试证据见对应验收报告。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_DEFINITIONS,
  readShortcutBindings,
  setShortcutBinding,
  shortcutOverrides,
} from "../src/shortcuts.ts";

// 空覆盖项应完整恢复当前默认快捷键，且不产生待持久化记录。
test("空配置恢复全部默认快捷键", () => {
  assert.deepEqual(readShortcutBindings(), DEFAULT_SHORTCUT_BINDINGS);
  assert.deepEqual(shortcutOverrides(readShortcutBindings()), {});
  assert.equal(Object.keys(readShortcutBindings()).length, 12);
});

// 用互不冲突的组合键覆盖全部动作，验证写入值能够无损读取。
test("全部十二个自定义快捷键可往返读取", () => {
  const bindings = { ...DEFAULT_SHORTCUT_BINDINGS };
  SHORTCUT_DEFINITIONS.forEach(({ id }, index) => {
    bindings[id] = `Mod+Alt+Shift+Key${String.fromCharCode(65 + index)}`;
  });
  assert.deepEqual(readShortcutBindings(shortcutOverrides(bindings)), bindings);
});

// 保留键不应替换已提交快照。
test("系统保留键被拒绝且原配置不变", () => {
  const result = setShortcutBinding(DEFAULT_SHORTCUT_BINDINGS, "bold", "Mod+KeyC");
  assert.match(result.error, /复制/);
  assert.deepEqual(result.bindings, DEFAULT_SHORTCUT_BINDINGS);
});

// 两个动作不能绑定同一组合键，读取时也不能接受真正的冲突。
test("真正冲突的快捷键被拒绝", () => {
  assert.throws(() => readShortcutBindings({ bold: "Mod+KeyI" }), /冲突/);
});

// 复现界面允许的三次修改；最终组合无冲突，重启必须能够读取。
test("界面合法互换的快捷键在重启后仍能读取", () => {
  let bindings = { ...DEFAULT_SHORTCUT_BINDINGS };
  for (const [id, chord] of [
    ["bold", "Mod+Alt+KeyB"],
    ["italic", "Mod+KeyB"],
    ["bold", "Mod+KeyI"],
  ]) {
    const result = setShortcutBinding(bindings, id, chord);
    assert.equal(result.error, null);
    bindings = result.bindings;
  }
  assert.deepEqual(readShortcutBindings(shortcutOverrides(bindings)), bindings);
});

// 数据库损坏为非空但无法触发的 chord 时应报错，而不是挂载主界面。
test("读取非法快捷键字符串时阻断而不是静默接受", () => {
  assert.throws(() => readShortcutBindings({ bold: "invalid-chord" }));
});
