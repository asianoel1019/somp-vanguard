/**
 * Safe Expression Evaluator for Workflow Condition nodes.
 *
 * Replaces `new Function()` with a small whitelist-based interpreter so that
 * condition expressions cannot reach process, require, or the prototype chain.
 *
 * Supported: number / string / true / false / null / undefined literals, `ctx`,
 * member access (a.b, a["b"], a[0]), ! - + unary, * / % + - arithmetic,
 * < <= > >= == != === !== comparison, && || (short-circuit), a ? b : c,
 * whitelisted global functions, Math helpers and string / array methods.
 */

const MAX_LENGTH = 2000;

const GLOBAL_FNS = {
    parseInt, parseFloat, Number, String, Boolean, isNaN, isFinite,
};
const MATH_FNS = new Set(['abs', 'max', 'min', 'round', 'floor', 'ceil']);
const STRING_METHODS = new Set([
    'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf',
    'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd',
    'split', 'slice', 'substring', 'charAt',
]);
const ARRAY_METHODS = new Set(['includes', 'indexOf', 'lastIndexOf', 'join', 'slice']);
const NUMBER_METHODS = new Set(['toFixed']);
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

const OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '[', ']', '.', ',', '?', ':'];
const BINARY_PRECEDENCE = {
    '||': 1, '&&': 2,
    '==': 3, '!=': 3, '===': 3, '!==': 3,
    '<': 4, '<=': 4, '>': 4, '>=': 4,
    '+': 5, '-': 5,
    '*': 6, '/': 6, '%': 6,
};
const LITERAL_IDENTS = { true: true, false: false, null: null, undefined: undefined };

// ─── Tokenizer ─────────────────────────────────────

function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (/\s/.test(ch)) { i++; continue; }

        if (/[0-9]/.test(ch)) {
            const m = /^\d+(\.\d+)?/.exec(src.slice(i));
            tokens.push({ type: 'num', value: Number(m[0]), pos: i });
            i += m[0].length;
            continue;
        }

        if (/[A-Za-z_$]/.test(ch)) {
            const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
            tokens.push({ type: 'ident', value: m[0], pos: i });
            i += m[0].length;
            continue;
        }

        if (ch === '"' || ch === "'") {
            const start = i;
            let value = '';
            i++;
            while (i < src.length && src[i] !== ch) {
                if (src[i] === '\\' && i + 1 < src.length) {
                    const esc = src[i + 1];
                    value += { n: '\n', t: '\t', r: '\r' }[esc] ?? esc;
                    i += 2;
                } else {
                    value += src[i++];
                }
            }
            if (i >= src.length) throw new Error(`Unterminated string starting at position ${start}`);
            i++;
            tokens.push({ type: 'str', value, pos: start });
            continue;
        }

        const op = OPERATORS.find(o => src.startsWith(o, i));
        if (!op) throw new Error(`Unexpected character "${ch}" at position ${i}`);
        tokens.push({ type: 'op', value: op, pos: i });
        i += op.length;
    }
    tokens.push({ type: 'eof', pos: src.length });
    return tokens;
}

// ─── Parser (recursive descent) ────────────────────

function parse(src) {
    const tokens = tokenize(src);
    let p = 0;

    const peek = () => tokens[p];
    const isOp = (v) => tokens[p].type === 'op' && tokens[p].value === v;
    const unexpected = (tok) => {
        if (tok.type === 'eof') return new Error('Unexpected end of expression');
        return new Error(`Unexpected token "${tok.value}" at position ${tok.pos}`);
    };
    const expectOp = (v) => {
        if (!isOp(v)) throw unexpected(peek());
        p++;
    };

    function parseTernary() {
        const test = parseBinary(1);
        if (!isOp('?')) return test;
        p++;
        const consequent = parseTernary();
        expectOp(':');
        const alternate = parseTernary();
        return { type: 'Conditional', test, consequent, alternate };
    }

    function parseBinary(minPrec) {
        let left = parseUnary();
        for (;;) {
            const tok = peek();
            const prec = tok.type === 'op' ? BINARY_PRECEDENCE[tok.value] : undefined;
            if (prec === undefined || prec < minPrec) return left;
            p++;
            const right = parseBinary(prec + 1);
            left = { type: 'Binary', op: tok.value, left, right };
        }
    }

    function parseUnary() {
        if (isOp('!') || isOp('-') || isOp('+')) {
            const op = tokens[p++].value;
            return { type: 'Unary', op, argument: parseUnary() };
        }
        return parsePostfix(parsePrimary());
    }

    function parsePostfix(node) {
        for (;;) {
            if (isOp('.')) {
                p++;
                const tok = peek();
                if (tok.type !== 'ident') throw unexpected(tok);
                p++;
                node = { type: 'Member', object: node, property: { type: 'Literal', value: tok.value } };
            } else if (isOp('[')) {
                p++;
                const property = parseTernary();
                expectOp(']');
                node = { type: 'Member', object: node, property };
            } else if (isOp('(')) {
                p++;
                const args = [];
                if (!isOp(')')) {
                    args.push(parseTernary());
                    while (isOp(',')) { p++; args.push(parseTernary()); }
                }
                expectOp(')');
                node = { type: 'Call', callee: node, args };
            } else {
                return node;
            }
        }
    }

    function parsePrimary() {
        const tok = peek();
        if (tok.type === 'num' || tok.type === 'str') {
            p++;
            return { type: 'Literal', value: tok.value };
        }
        if (tok.type === 'ident') {
            p++;
            if (Object.prototype.hasOwnProperty.call(LITERAL_IDENTS, tok.value)) {
                return { type: 'Literal', value: LITERAL_IDENTS[tok.value] };
            }
            return { type: 'Identifier', name: tok.value };
        }
        if (isOp('(')) {
            p++;
            const expr = parseTernary();
            expectOp(')');
            return expr;
        }
        throw unexpected(tok);
    }

    const ast = parseTernary();
    if (peek().type !== 'eof') throw unexpected(peek());
    return ast;
}

// ─── Evaluator ─────────────────────────────────────

const isGlobalFn = (name) => Object.prototype.hasOwnProperty.call(GLOBAL_FNS, name);
const isPrimitive = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function');

function describe(value) {
    return value === null ? 'null' : 'undefined';
}

function getProperty(obj, key) {
    if (obj === null || obj === undefined) {
        throw new Error(`Cannot read property "${key}" of ${describe(obj)}`);
    }
    if (BLOCKED_KEYS.has(key)) throw new Error(`Property "${key}" is not allowed`);

    const boxed = Object(obj);
    if (Object.prototype.hasOwnProperty.call(boxed, key)) {
        const value = boxed[key];
        if (typeof value === 'function') throw new Error(`Cannot use function "${key}" as a value`);
        return value;
    }
    // Inherited members (toString, hasOwnProperty, methods...) are not exposed
    if (key in boxed) throw new Error(`Property "${key}" is not allowed`);
    return undefined;
}

function evalArgs(args, ctx) {
    return args.map(a => {
        const v = evalNode(a, ctx);
        if (!isPrimitive(v)) throw new Error('Function arguments must be primitive values (string, number, boolean, null)');
        return v;
    });
}

function evalCall(node, ctx) {
    const { callee } = node;

    if (callee.type === 'Identifier') {
        if (!isGlobalFn(callee.name)) throw new Error(`Unknown identifier "${callee.name}"`);
        return GLOBAL_FNS[callee.name](...evalArgs(node.args, ctx));
    }

    if (callee.type === 'Member') {
        if (callee.object.type === 'Identifier' && callee.object.name === 'Math') {
            const name = String(evalNode(callee.property, ctx));
            if (!MATH_FNS.has(name)) throw new Error(`Math.${name} is not allowed`);
            return Math[name](...evalArgs(node.args, ctx));
        }

        const target = evalMemberObject(callee.object, ctx);
        const name = String(evalNode(callee.property, ctx));
        if (target === null || target === undefined) {
            throw new Error(`Cannot read property "${name}" of ${describe(target)}`);
        }
        let method;
        if (typeof target === 'string' && STRING_METHODS.has(name)) method = String.prototype[name];
        else if (Array.isArray(target) && ARRAY_METHODS.has(name)) method = Array.prototype[name];
        else if (typeof target === 'number' && NUMBER_METHODS.has(name)) method = Number.prototype[name];
        if (!method) throw new Error(`Method "${name}" is not allowed`);
        return method.apply(target, evalArgs(node.args, ctx));
    }

    throw new Error('Cannot call the result of an expression');
}

function evalMemberObject(objectNode, ctx) {
    if (objectNode.type === 'Identifier' && (objectNode.name === 'Math' || isGlobalFn(objectNode.name))) {
        throw new Error(`Properties of "${objectNode.name}" are not allowed`);
    }
    return evalNode(objectNode, ctx);
}

function evalBinary(op, l, r) {
    switch (op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '%': return l % r;
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
        // eslint-disable-next-line eqeqeq
        case '==': return l == r;
        // eslint-disable-next-line eqeqeq
        case '!=': return l != r;
        case '===': return l === r;
        case '!==': return l !== r;
        default: throw new Error(`Unsupported operator "${op}"`);
    }
}

function evalNode(node, ctx) {
    switch (node.type) {
        case 'Literal':
            return node.value;
        case 'Identifier':
            if (node.name === 'ctx') return ctx;
            if (node.name === 'Math' || isGlobalFn(node.name)) throw new Error(`Cannot use function "${node.name}" as a value`);
            throw new Error(`Unknown identifier "${node.name}"`);
        case 'Member': {
            const obj = evalMemberObject(node.object, ctx);
            return getProperty(obj, String(evalNode(node.property, ctx)));
        }
        case 'Call':
            return evalCall(node, ctx);
        case 'Unary': {
            const v = evalNode(node.argument, ctx);
            if (node.op === '!') return !v;
            if (node.op === '-') return -v;
            return +v;
        }
        case 'Binary':
            if (node.op === '&&') {
                const l = evalNode(node.left, ctx);
                return l ? evalNode(node.right, ctx) : l;
            }
            if (node.op === '||') {
                const l = evalNode(node.left, ctx);
                return l ? l : evalNode(node.right, ctx);
            }
            return evalBinary(node.op, evalNode(node.left, ctx), evalNode(node.right, ctx));
        case 'Conditional':
            return evalNode(node.test, ctx) ? evalNode(node.consequent, ctx) : evalNode(node.alternate, ctx);
        default:
            throw new Error(`Unsupported syntax "${node.type}"`);
    }
}

/**
 * Evaluates a condition expression against the workflow context.
 * Throws an Error with a readable message on syntax errors or disallowed access.
 */
function evaluate(expr, ctx = {}) {
    if (typeof expr !== 'string' || !expr.trim()) throw new Error('Expression is empty');
    if (expr.length > MAX_LENGTH) throw new Error(`Expression is too long (max ${MAX_LENGTH} characters)`);
    return evalNode(parse(expr), ctx);
}

module.exports = { evaluate };
