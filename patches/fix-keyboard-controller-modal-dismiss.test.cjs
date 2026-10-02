const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchSource, patchKeyboardControllerModalDismiss } = require('./fix-keyboard-controller-modal-dismiss.cjs');

const watcher = 'android/src/main/java/com/reactnativekeyboardcontroller/modal/ModalAttachedWatcher.kt';
// The dismiss listener as shipped by 1.22.x, before this patch.
const upstream = `      dialog?.setOnDismissListener {
        callback.syncKeyboardPosition()
        callback.destroy()
        eventView.removeSelf()
        // un-pause it in next frame because straight away \`onApplyWindowInsets\` will be called
        view.post {
          this.callback()?.suspend(false)
        }
      }`;
const fixture = `class ModalAttachedWatcher {\n${upstream}\n}\n`;

function dismissListener(source) {
    const start = source.indexOf('dialog?.setOnDismissListener {');
    return source.slice(start, source.indexOf('\n      }', start));
}

test('on dismiss, stops the Modal callback and re-syncs from the main window only', () => {
    const listener = dismissListener(patchSource(fixture));
    // No sync may read the Modal window's (possibly mid-hide) insets.
    assert.doesNotMatch(listener, /^\s*callback\.syncKeyboardPosition\(\)/m);
    assert.match(listener, /callback\.suspend\(true\)\n\s*callback\.destroy\(\)/);
    // Main callback resumes first, then publishes the main window's keyboard state.
    assert.match(listener, /view\.post \{[^}]*suspend\(false\)[^}]*this\.callback\(\)\?\.syncKeyboardPosition\(\)/);
});

test('is idempotent and fails on drifted upstream code', () => {
    const patched = patchSource(fixture);
    assert.equal(patchSource(patched), patched);
    for (const source of [
        fixture.replace('callback.destroy()', 'callback.release()'),
        fixture + fixture,
    ]) assert.throws(() => patchSource(source), /Unexpected react-native-keyboard-controller/);
});

test('patches every installed copy before writing and skips missing packages', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keyboard-controller-patch-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const roots = ['a', 'b', 'empty'].map(name => path.join(directory, name));
    for (const root of roots.slice(0, 2)) {
        const pkg = path.join(root, 'react-native-keyboard-controller');
        fs.mkdirSync(path.dirname(path.join(pkg, watcher)), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"1.22.6"}');
        fs.writeFileSync(path.join(pkg, watcher), fixture);
    }
    assert.equal(patchKeyboardControllerModalDismiss(roots), 2);
    assert.equal(patchKeyboardControllerModalDismiss(roots), 0);

    fs.writeFileSync(path.join(roots[1], 'react-native-keyboard-controller', watcher), 'drifted');
    fs.writeFileSync(path.join(roots[0], 'react-native-keyboard-controller', watcher), fixture);
    assert.throws(() => patchKeyboardControllerModalDismiss(roots), /Unexpected/);
    assert.equal(fs.readFileSync(path.join(roots[0], 'react-native-keyboard-controller', watcher), 'utf8'), fixture);
});

