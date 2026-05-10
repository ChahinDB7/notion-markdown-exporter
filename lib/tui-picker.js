// Reusable raw-mode TTY prompts shared by the project's CLI scripts.
// Four prompts: singleSelect, multiSelect, promptText, promptConfirm.
// All four support Esc-to-go-back via { allowBack: true } — they return
// the BACK sentinel instead of a value when the user presses Esc.
// Ctrl-C always aborts the process (exit 130).

import { stdin, stdout } from 'node:process';

export const BACK = Symbol('tui:back');

// ---------- key parsing ----------

// Raw-mode delivers each keystroke as one chunk on macOS/Linux. We map
// the byte sequence to a normalized key name (string) or, for printable
// characters, a `{ type: 'char', char }` object.
function parseKey(chunk) {
	switch (chunk) {
		case '\x03': return 'ctrl-c';
		case '\x1b': return 'esc';
		case '\r':
		case '\n': return 'enter';
		case ' ': return 'space';
		case '\x7f':
		case '\x08': return 'backspace';
		case '\x1b[A': return 'up';
		case '\x1b[B': return 'down';
		case '\x1b[C': return 'right';
		case '\x1b[D': return 'left';
		case '\x1b[H':
		case '\x01': return 'home';
		case '\x1b[F':
		case '\x05': return 'end';
		case '\x1b[5~': return 'pgup';
		case '\x1b[6~': return 'pgdn';
		case '\x1b[3~': return 'delete';
		default:
			if (chunk.length === 1) {
				const code = chunk.charCodeAt(0);
				if (code >= 32 && code < 127) return { type: 'char', char: chunk };
			}
			return { type: 'raw', chunk };
	}
}

function isCharKey(key, ...chars) {
	return typeof key === 'object' && key.type === 'char' && chars.includes(key.char);
}

// ---------- raw-mode runner ----------

// Generic loop: enter raw mode, draw an initial frame, then on each key
// call onKey(key, finish). The handler may mutate captured state and call
// finish(value) to resolve. Between keystrokes, the frame is re-rendered
// using a "move up N lines + erase to end" trick so the prompt updates in
// place. Ctrl-C is intercepted globally and exits 130.
function runPrompt({ render, onKey }) {
	if (!stdin.isTTY) {
		return Promise.reject(
			new Error('Interactive prompt requires a TTY. Run from a terminal.')
		);
	}
	return new Promise((resolve) => {
		let lastLines = 0;
		let resolved = false;

		const draw = () => {
			if (lastLines > 0) stdout.write(`\x1b[${lastLines}A\x1b[J`);
			const frame = render();
			stdout.write(frame);
			lastLines = frame.split('\n').length - 1;
		};

		const cleanup = () => {
			stdin.setRawMode(false);
			stdin.removeListener('data', onData);
			stdin.pause();
		};

		const finish = (value) => {
			if (resolved) return;
			resolved = true;
			cleanup();
			stdout.write('\n');
			resolve(value);
		};

		const onData = (chunk) => {
			if (resolved) return;
			const key = parseKey(chunk);
			if (key === 'ctrl-c') {
				resolved = true;
				cleanup();
				stdout.write('\nAborted.\n');
				process.exit(130);
			}
			onKey(key, finish);
			if (!resolved) draw();
		};

		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		stdin.on('data', onData);
		draw();
	});
}

// ---------- shared visuals ----------

const HIGHLIGHT_ON = '\x1b[7m';
const HIGHLIGHT_OFF = '\x1b[0m';

function defaultSingleSelectHint(allowBack) {
	const parts = ['↑/↓ move', 'Space mark', 'Enter select'];
	if (allowBack) parts.push('Esc back');
	parts.push('Ctrl-C cancel');
	return parts.join(' · ');
}

function defaultMultiSelectHint(allowBack) {
	const parts = ['↑/↓ move', 'Space toggle', 'A toggle all', 'Enter confirm'];
	if (allowBack) parts.push('Esc back');
	parts.push('Ctrl-C cancel');
	return parts.join(' · ');
}

function defaultTextHint(defaultValue, allowBack) {
	const parts = ['Enter submit'];
	if (defaultValue) parts.push(`empty = "${defaultValue}"`);
	if (allowBack) parts.push('Esc back');
	parts.push('Ctrl-C cancel');
	return parts.join(' · ');
}

function defaultConfirmHint(allowBack) {
	const parts = ['↑/↓ move', 'Enter select'];
	if (allowBack) parts.push('Esc back');
	parts.push('Ctrl-C cancel');
	return parts.join(' · ');
}

// ---------- singleSelect ----------

// Single-row picker. Up/Down to move, Space to mark (only one mark at a
// time), Enter on a row to pick it immediately, Enter on the Continue row
// to pick the marked row.
export async function singleSelect({
	header,
	hint,
	items,
	renderItem,
	prefix,
	groupHeader,
	showContinue = true,
	allowBack = false,
	initialIndex = 0,
}) {
	if (!Array.isArray(items) || items.length === 0) {
		throw new Error('singleSelect: items must be a non-empty array.');
	}
	const hintLine = hint ?? defaultSingleSelectHint(allowBack);
	const prefixFn = prefix || (() => '');
	const groupHeaderFn = groupHeader || (() => null);
	const continueIdx = items.length;
	const totalRows = items.length + (showContinue ? 1 : 0);
	let cursor = Math.max(0, Math.min(items.length - 1, Number.isFinite(initialIndex) ? Math.trunc(initialIndex) : 0));
	let marked = -1;
	let message = '';

	const render = () => {
		let out = '\n' + header + '\n  ' + hintLine + '\n\n';
		let prevItem = null;
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const gh = groupHeaderFn(item, prevItem);
			if (gh) out += '  ' + gh + '\n';
			const isCursor = i === cursor;
			const isMarked = i === marked;
			const cursorMark = isCursor ? '› ' : '  ';
			const checkbox = isMarked ? '[x]' : '[ ]';
			const pre = prefixFn(item, i);
			const line = `${cursorMark}${checkbox} ${pre}${renderItem(item, i)}`;
			out += isCursor ? `${HIGHLIGHT_ON}${line}${HIGHLIGHT_OFF}\n` : `${line}\n`;
			prevItem = item;
		}
		if (showContinue) {
			const onCont = cursor === continueIdx;
			const contMark = onCont ? '› ' : '  ';
			const contLine = `${contMark}▶ Continue`;
			out += '\n' + (onCont ? `${HIGHLIGHT_ON}${contLine}${HIGHLIGHT_OFF}\n` : `${contLine}\n`);
		}
		if (message) out += '\n' + message + '\n';
		return out;
	};

	return runPrompt({
		render,
		onKey: (key, finish) => {
			const confirmFromContinue = () => {
				if (marked === -1) {
					message = '⚠️  Mark a row with Space first, or press Enter on the row you want.';
					return;
				}
				finish(items[marked]);
			};
			if (key === 'esc') {
				if (allowBack) finish(BACK);
				return;
			}
			if (key === 'up' || isCharKey(key, 'k')) {
				cursor = (cursor - 1 + totalRows) % totalRows;
				message = '';
			} else if (key === 'down' || isCharKey(key, 'j')) {
				cursor = (cursor + 1) % totalRows;
				message = '';
			} else if (key === 'pgup') {
				cursor = Math.max(0, cursor - 10);
				message = '';
			} else if (key === 'pgdn') {
				cursor = Math.min(totalRows - 1, cursor + 10);
				message = '';
			} else if (key === 'home') {
				cursor = 0;
				message = '';
			} else if (key === 'end') {
				cursor = totalRows - 1;
				message = '';
			} else if (key === 'space') {
				if (showContinue && cursor === continueIdx) {
					confirmFromContinue();
				} else {
					marked = cursor;
					message = '';
				}
			} else if (key === 'enter') {
				if (showContinue && cursor === continueIdx) {
					confirmFromContinue();
				} else {
					finish(items[cursor]);
				}
			}
		},
	});
}

// ---------- multiSelect ----------

// Multi-row picker. Returns a Set<key> (key from keyFn). cascadeFn lets
// the caller propagate toggles (e.g. to descendants in a tree).
export async function multiSelect({
	header,
	hint,
	items,
	renderItem,
	prefix,
	groupHeader,
	keyFn,
	cascadeFn,
	initialChecked,
	allowBack = false,
}) {
	if (!Array.isArray(items) || items.length === 0) {
		throw new Error('multiSelect: items must be a non-empty array.');
	}
	const hintLine = hint ?? defaultMultiSelectHint(allowBack);
	const prefixFn = prefix || (() => '');
	const groupHeaderFn = groupHeader || (() => null);
	const idOf = keyFn || ((item) => item);

	const checked = new Set();
	if (initialChecked) {
		for (const k of initialChecked) checked.add(k);
	}

	const continueIdx = items.length;
	const totalRows = items.length + 1;
	let cursor = 0;
	let message = '';

	const toggle = (item) => {
		const k = idOf(item);
		const on = !checked.has(k);
		const apply = (key) => {
			if (on) checked.add(key);
			else checked.delete(key);
		};
		apply(k);
		if (cascadeFn) {
			const others = cascadeFn(item, items) || [];
			for (const other of others) apply(idOf(other));
		}
	};

	const toggleAll = () => {
		if (checked.size === items.length) checked.clear();
		else for (const item of items) checked.add(idOf(item));
	};

	const render = () => {
		let out = '\n' + header + '\n  ' + hintLine + '\n  Selected: ' + checked.size + '/' + items.length + '\n\n';
		let prevItem = null;
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const gh = groupHeaderFn(item, prevItem);
			if (gh) out += '  ' + gh + '\n';
			const isCursor = i === cursor;
			const isChecked = checked.has(idOf(item));
			const cursorMark = isCursor ? '› ' : '  ';
			const checkbox = isChecked ? '[x]' : '[ ]';
			const pre = prefixFn(item, i);
			const line = `${cursorMark}${checkbox} ${pre}${renderItem(item, i)}`;
			out += isCursor ? `${HIGHLIGHT_ON}${line}${HIGHLIGHT_OFF}\n` : `${line}\n`;
			prevItem = item;
		}
		const onCont = cursor === continueIdx;
		const contMark = onCont ? '› ' : '  ';
		const contLine = `${contMark}▶ Continue`;
		out += '\n' + (onCont ? `${HIGHLIGHT_ON}${contLine}${HIGHLIGHT_OFF}\n` : `${contLine}\n`);
		if (message) out += '\n' + message + '\n';
		return out;
	};

	return runPrompt({
		render,
		onKey: (key, finish) => {
			const tryConfirm = () => {
				if (checked.size === 0) {
					message = '⚠️  Select at least one (Space toggles the highlighted row).';
					return;
				}
				finish(new Set(checked));
			};
			if (key === 'esc') {
				if (allowBack) finish(BACK);
				return;
			}
			if (key === 'up' || isCharKey(key, 'k')) {
				cursor = (cursor - 1 + totalRows) % totalRows;
				message = '';
			} else if (key === 'down' || isCharKey(key, 'j')) {
				cursor = (cursor + 1) % totalRows;
				message = '';
			} else if (key === 'pgup') {
				cursor = Math.max(0, cursor - 10);
				message = '';
			} else if (key === 'pgdn') {
				cursor = Math.min(totalRows - 1, cursor + 10);
				message = '';
			} else if (key === 'home') {
				cursor = 0;
				message = '';
			} else if (key === 'end') {
				cursor = totalRows - 1;
				message = '';
			} else if (key === 'space') {
				if (cursor === continueIdx) tryConfirm();
				else {
					toggle(items[cursor]);
					message = '';
				}
			} else if (isCharKey(key, 'a', 'A')) {
				toggleAll();
				message = '';
			} else if (key === 'enter') {
				tryConfirm();
			}
		},
	});
}

// ---------- promptText ----------

function renderInputLine(buffer, caret) {
	if (caret >= buffer.length) {
		return buffer + HIGHLIGHT_ON + ' ' + HIGHLIGHT_OFF;
	}
	return (
		buffer.slice(0, caret) +
		HIGHLIGHT_ON + buffer[caret] + HIGHLIGHT_OFF +
		buffer.slice(caret + 1)
	);
}

// Minimal raw-mode line input. Supports Backspace/Delete, Left/Right,
// Home/End, character insertion. Enter submits (or returns defaultValue
// if the buffer is empty). Esc returns BACK when allowBack.
export async function promptText({
	message,
	defaultValue,
	validate,
	allowBack = false,
	initialValue,
}) {
	let buffer = typeof initialValue === 'string' ? initialValue : '';
	let caret = buffer.length;
	let error = '';
	const hintLine = defaultTextHint(defaultValue, allowBack);

	const render = () => {
		let out = '\n' + message + '\n  ' + hintLine + '\n\n';
		out += '  ❯ ' + renderInputLine(buffer, caret) + '\n';
		if (error) out += '\n  ❌ ' + error + '\n';
		return out;
	};

	return runPrompt({
		render,
		onKey: (key, finish) => {
			if (key === 'esc') {
				if (allowBack) finish(BACK);
				return;
			}
			if (key === 'enter') {
				const value = buffer.length > 0 ? buffer : (defaultValue ?? '');
				if (validate) {
					const err = validate(value);
					if (err) {
						error = err;
						return;
					}
				}
				finish(value);
				return;
			}
			if (key === 'backspace') {
				if (caret > 0) {
					buffer = buffer.slice(0, caret - 1) + buffer.slice(caret);
					caret--;
					error = '';
				}
				return;
			}
			if (key === 'delete') {
				if (caret < buffer.length) {
					buffer = buffer.slice(0, caret) + buffer.slice(caret + 1);
					error = '';
				}
				return;
			}
			if (key === 'left') {
				if (caret > 0) caret--;
				return;
			}
			if (key === 'right') {
				if (caret < buffer.length) caret++;
				return;
			}
			if (key === 'home') {
				caret = 0;
				return;
			}
			if (key === 'end') {
				caret = buffer.length;
				return;
			}
			if (typeof key === 'object' && key.type === 'char') {
				buffer = buffer.slice(0, caret) + key.char + buffer.slice(caret);
				caret++;
				error = '';
			}
		},
	});
}

// ---------- promptConfirm ----------

// Two-option arrow-key picker: Yes (top) and No (bottom). Cursor starts
// on No so accidental Enters don't proceed. Up/Down (or j/k) navigate;
// Enter selects. Space and y/n shortcuts are intentionally ignored — the
// confirm is meant to be a deliberate keystroke.
//
// Returns:
//   - true  on Yes
//   - BACK  on No when allowBack is true (treated as "go back" by callers)
//   - false on No when allowBack is false (treated as "decline")
//   - BACK  on Esc when allowBack is true
//   - (Esc is ignored when allowBack is false)
export async function promptConfirm({
	message,
	allowBack = false,
}) {
	const items = ['Yes', 'No'];
	let cursor = 1; // start on No to prevent accidental Enter-confirm
	const hintLine = defaultConfirmHint(allowBack);

	const render = () => {
		let out = '\n' + message + '\n  ' + hintLine + '\n\n';
		for (let i = 0; i < items.length; i++) {
			const isCursor = i === cursor;
			const cursorMark = isCursor ? '› ' : '  ';
			const line = `${cursorMark}▶ ${items[i]}`;
			out += isCursor ? `${HIGHLIGHT_ON}${line}${HIGHLIGHT_OFF}\n` : `${line}\n`;
		}
		return out;
	};

	return runPrompt({
		render,
		onKey: (key, finish) => {
			if (key === 'esc') {
				if (allowBack) finish(BACK);
				return;
			}
			if (key === 'up' || isCharKey(key, 'k')) {
				cursor = (cursor - 1 + items.length) % items.length;
			} else if (key === 'down' || isCharKey(key, 'j')) {
				cursor = (cursor + 1) % items.length;
			} else if (key === 'enter') {
				if (cursor === 0) finish(true);
				else finish(allowBack ? BACK : false);
			}
			// Space, y/n, and every other key are intentionally ignored.
		},
	});
}
