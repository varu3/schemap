import { StreamLanguage } from '@codemirror/language';

// Atlas HCL のブロック名。ラベルか { が続くときだけキーワードとして色を付ける
const BLOCKS = new Set([
  'table',
  'column',
  'primary_key',
  'foreign_key',
  'index',
  'unique',
  'check',
  'on',
  'enum',
  'schema',
  'trigger',
  'function',
  'extension',
  'sequence',
  'event_trigger',
  'variable',
  'before',
  'after',
  'execute',
]);

// depth は開いている { [ の数。改行したときの字下げに使う
type State = { comment: boolean; heredoc?: string; depth: number };

// 色付けだけの簡易な HCL。構文の検査はしない（サーバー側の解析が受け持つ）
export const hcl = StreamLanguage.define<State>({
  name: 'hcl',
  startState: () => ({ comment: false, depth: 0 }),
  token(stream, state) {
    if (state.heredoc !== undefined) {
      if (stream.sol() && stream.match(new RegExp(`^\\s*${state.heredoc}\\s*$`))) {
        state.heredoc = undefined;
        return 'string';
      }
      stream.skipToEnd();
      return 'string';
    }
    if (state.comment) {
      if (stream.skipTo('*/')) {
        stream.match('*/');
        state.comment = false;
      } else {
        stream.skipToEnd();
      }
      return 'comment';
    }
    if (stream.eatSpace()) {
      return null;
    }
    if (stream.match('/*')) {
      state.comment = true;
      return 'comment';
    }
    if (stream.match('#') || stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    const heredoc = stream.match(/^<<-?([A-Za-z_]\w*)/);
    if (heredoc) {
      state.heredoc = (heredoc as RegExpMatchArray)[1];
      return 'string';
    }
    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      for (let ch = stream.next(); ch !== undefined; ch = stream.next()) {
        if (ch === '"' && !escaped) {
          break;
        }
        escaped = !escaped && ch === '\\';
      }
      return 'string';
    }
    if (stream.match(/^-?\d+(\.\d+)?/)) {
      return 'number';
    }
    if (stream.match(/^(true|false|null)\b/)) {
      return 'atom';
    }
    const word = stream.match(/^[A-Za-z_][\w-]*/);
    if (word) {
      const name = (word as RegExpMatchArray)[0];
      if (BLOCKS.has(name) && stream.match(/^\s*["{]/, false)) {
        return 'keyword';
      }
      if (stream.match(/^\s*=(?!=)/, false)) {
        return 'propertyName';
      }
      return 'variableName';
    }
    const ch = stream.next();
    if (ch === '{' || ch === '[') {
      state.depth++;
    } else if ((ch === '}' || ch === ']') && state.depth > 0) {
      state.depth--;
    }
    return null;
  },
  // } や ] で始まる行は 1 段戻す
  indent(state, textAfter, cx) {
    const depth = /^\s*[}\]]/.test(textAfter) ? state.depth - 1 : state.depth;
    return Math.max(depth, 0) * cx.unit;
  },
});
