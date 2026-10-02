/**
 * react-native-keyboard-controller 1.22.x, Android 12+: while a React Native
 * Modal is shown, the keyboard belongs to the Modal's window, so the library
 * pauses the main-window callback and follows a Modal-window callback instead.
 * When the Modal closes, it re-syncs the shared keyboard height from the
 * Modal's window. If the keyboard is still mid-hide (Keyboard.dismiss() and the
 * Modal closing together), that window still reports the keyboard as up, so JS
 * receives keyboardDidShow with the full height. The main window never saw that
 * keyboard, so no hide event ever follows and every keyboard-following view in
 * the app (home dock, session composer) stays lifted until the next keyboard.
 *
 * On dismiss, silence the Modal callback (a late onEnd from its dying window
 * would carry the same stale height) and re-sync from the main window, which
 * owns the layout the app draws in. Fails on drifted upstream code rather than
 * skipping.
 */
const fs = require('node:fs');
const path = require('node:path');

const relative = 'android/src/main/java/com/reactnativekeyboardcontroller/modal/ModalAttachedWatcher.kt';

const before = `      dialog?.setOnDismissListener {
        callback.syncKeyboardPosition()
        callback.destroy()
        eventView.removeSelf()
        // un-pause it in next frame because straight away \`onApplyWindowInsets\` will be called
        view.post {
          this.callback()?.suspend(false)
        }
      }`;

const after = `      dialog?.setOnDismissListener {
        // The Modal window may still report the keyboard as visible while it is
        // hiding, so neither sync from it nor let its late onEnd reach JS.
        callback.suspend(true)
        callback.destroy()
        eventView.removeSelf()
        // un-pause it in next frame because straight away \`onApplyWindowInsets\` will be called
        view.post {
          this.callback()?.suspend(false)
          // the main window is the source of truth once the Modal is gone
          this.callback()?.syncKeyboardPosition()
        }
      }`;

function patchSource(source) {
    if (source.split(after).length === 2 && !source.includes(before)) return source;
    if (source.split(before).length !== 2) {
        throw new Error('[patch] Unexpected react-native-keyboard-controller ModalAttachedWatcher; review fix-keyboard-controller-modal-dismiss.cjs');
    }
    return source.replace(before, after);
}

function patchKeyboardControllerModalDismiss(nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
]) {
    const changes = new Map();
    for (const root of nodeModulesRoots) {
        const packageRoot = path.join(root, 'react-native-keyboard-controller');
        if (!fs.existsSync(path.join(packageRoot, 'package.json'))) continue;
        const file = fs.realpathSync(path.join(packageRoot, relative));
        const source = fs.readFileSync(file, 'utf8');
        const patched = patchSource(source);
        if (patched !== source) changes.set(file, patched);
    }
    // Validate every installed copy before changing any of them.
    for (const [file, source] of changes) fs.writeFileSync(file, source);
    if (changes.size) console.log(`[patch] Fixed keyboard-controller stale height after Modal dismiss (${changes.size} file(s))`);
    return changes.size;
}

module.exports = { patchSource, patchKeyboardControllerModalDismiss };
if (require.main === module) patchKeyboardControllerModalDismiss();
