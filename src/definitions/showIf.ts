// Evaluates VIA `showIf` expressions such as
//   "{id_qmk_rgb_matrix_effect} != 0 && ({id_qmk_rgb_matrix_effect} < 4 || ...)"
// Supports numbers, {value_key} references, ! == != < > <= >= && || and ( ).
// Written as a tiny parser rather than eval() so definition files can't run code.

type Token =
  | {kind: 'num'; value: number}
  | {kind: 'ref'; key: string}
  | {kind: 'op'; op: string}
  | {kind: 'paren'; open: boolean};

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '{') {
      const end = expr.indexOf('}', i);
      if (end < 0) throw new Error(`Unclosed { in showIf: ${expr}`);
      tokens.push({kind: 'ref', key: expr.slice(i + 1, end).trim()});
      i = end + 1;
    } else if (c === '(' || c === ')') {
      tokens.push({kind: 'paren', open: c === '('});
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^(0x[0-9a-f]+|\d+)/i.exec(expr.slice(i))!;
      tokens.push({kind: 'num', value: Number(m[1])});
      i += m[1].length;
    } else {
      const two = expr.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
        tokens.push({kind: 'op', op: two});
        i += 2;
      } else if (['<', '>', '!'].includes(c)) {
        tokens.push({kind: 'op', op: c});
        i++;
      } else {
        throw new Error(`Unexpected "${c}" in showIf: ${expr}`);
      }
    }
  }
  return tokens;
}

/** Returns whether the expression is true for the given values (missing keys = 0). */
export function evaluateShowIf(expr: string, values: Record<string, number>): boolean {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (op: string) => {
    const t = peek();
    return t?.kind === 'op' && t.op === op;
  };

  const primary = (): number => {
    const t = tokens[pos++];
    if (!t) throw new Error(`Unexpected end of showIf: ${expr}`);
    if (t.kind === 'num') return t.value;
    if (t.kind === 'ref') return values[t.key] ?? 0;
    if (t.kind === 'op' && t.op === '!') return primary() ? 0 : 1;
    if (t.kind === 'paren' && t.open) {
      const v = or();
      const close = tokens[pos++];
      if (close?.kind !== 'paren' || close.open) throw new Error(`Missing ) in showIf: ${expr}`);
      return v;
    }
    throw new Error(`Unexpected token in showIf: ${expr}`);
  };

  const comparison = (): number => {
    let left = primary();
    for (;;) {
      const t = peek();
      if (t?.kind !== 'op' || !['==', '!=', '<', '>', '<=', '>='].includes(t.op)) return left;
      pos++;
      const right = primary();
      const r =
        t.op === '==' ? left === right
        : t.op === '!=' ? left !== right
        : t.op === '<' ? left < right
        : t.op === '>' ? left > right
        : t.op === '<=' ? left <= right
        : left >= right;
      left = r ? 1 : 0;
    }
  };

  const and = (): number => {
    let v = comparison();
    while (isOp('&&')) {
      pos++;
      const r = comparison();
      v = v && r ? 1 : 0;
    }
    return v;
  };

  const or = (): number => {
    let v = and();
    while (isOp('||')) {
      pos++;
      const r = and();
      v = v || r ? 1 : 0;
    }
    return v;
  };

  const result = or();
  if (pos !== tokens.length) throw new Error(`Trailing tokens in showIf: ${expr}`);
  return result !== 0;
}
