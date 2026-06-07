/**
 * condition-evaluator.ts
 *
 * SAST-safe condition and expression evaluator — zero eval(), zero new Function().
 * Expression evaluation uses a hand-rolled tokeniser/interpreter that only supports
 * the operators and built-ins defined in the schema specification.
 *
 * Supported expression grammar (subset of JS, schema-spec only):
 *   • Field access:   fields.field_id   fields.nested.path
 *   • Context access: context.key
 *   • Literals:       "string" 'string'  42  3.14  true  false  null
 *   • Comparisons:    ==  !=  >  >=  <  <=
 *   • Logic:          &&  ||  !
 *   • Null-coalesce:  ??
 *   • Ternary:        cond ? a : b
 *   • Arithmetic:     +  -  *  /
 *   • Grouping:       ( expr )
 *   • Built-ins:      today()  now()
 */

import type {
  ConditionOrRef, SimpleCondition, ExpressionCondition,
  CompositeCondition, ConditionRef, NamedCondition,
  FieldAnswers, FormContext, FormField,
} from "./types";

// ─── Type Guards ──────────────────────────────────────────────────────────────
function isSimple(c: ConditionOrRef): c is SimpleCondition {
  return "field" in c && "op" in c;
}
function isExpression(c: ConditionOrRef): c is ExpressionCondition {
  return "expression" in c && !("field" in c);
}
function isComposite(c: ConditionOrRef): c is CompositeCondition {
  return "all" in c || "any" in c || "not" in c;
}
function isRef(c: ConditionOrRef): c is ConditionRef {
  return "ref" in c;
}

// ─── Simple Condition Evaluator ───────────────────────────────────────────────
function evalSimple(cond: SimpleCondition, fields: FieldAnswers): boolean {
  const val = getNestedValue(fields, cond.field);
  const cmp = cond.value;
  switch (cond.op) {
    case "eq":          return val === cmp;
    case "neq":         return val !== cmp;
    case "gt":          return val != null && (val as number) > (cmp as number);
    case "gte":         return val != null && (val as number) >= (cmp as number);
    case "lt":          return val != null && (val as number) < (cmp as number);
    case "lte":         return val != null && (val as number) <= (cmp as number);
    case "in":          return Array.isArray(cmp) && cmp.includes(val);
    case "not_in":      return Array.isArray(cmp) && !cmp.includes(val);
    case "contains":    return typeof val === "string" && val.includes(String(cmp));
    case "starts_with": return typeof val === "string" && val.startsWith(String(cmp));
    case "ends_with":   return typeof val === "string" && val.endsWith(String(cmp));
    case "is_empty":    return val == null || val === "" || (Array.isArray(val) && val.length === 0);
    case "is_not_empty":return !(val == null || val === "" || (Array.isArray(val) && val.length === 0));
    case "is_true":     return val === true;
    case "is_false":    return val === false;
    default:            return false;
  }
}

// ─── Safe Expression Interpreter ─────────────────────────────────────────────
// Token types
type TT = "NUM"|"STR"|"BOOL"|"NULL"|"ID"|"DOT"|"LPAREN"|"RPAREN"|"BANG"
        |"AND"|"OR"|"EQ"|"NEQ"|"GT"|"GTE"|"LT"|"LTE"|"PLUS"|"MINUS"
        |"STAR"|"SLASH"|"TERNARY"|"COLON"|"NULLCOAL"|"EOF";
interface Token { type: TT; val: unknown; }

function tokenise(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const s = src.trim();
  while (i < s.length) {
    // skip whitespace
    if (/\s/.test(s[i])) { i++; continue; }
    // numbers
    if (/[0-9]/.test(s[i]) || (s[i] === "-" && /[0-9]/.test(s[i+1] ?? ""))) {
      let n = "";
      if (s[i] === "-") { n = "-"; i++; }
      while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++];
      toks.push({ type: "NUM", val: parseFloat(n) });
      continue;
    }
    // strings
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++]; let str = "";
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\" && i+1 < s.length) { i++; str += s[i++]; }
        else str += s[i++];
      }
      i++; // closing quote
      toks.push({ type: "STR", val: str });
      continue;
    }
    // identifiers and keywords
    if (/[a-zA-Z_$]/.test(s[i])) {
      let id = "";
      while (i < s.length && /[a-zA-Z0-9_$]/.test(s[i])) id += s[i++];
      if (id === "true")  { toks.push({ type: "BOOL", val: true  }); continue; }
      if (id === "false") { toks.push({ type: "BOOL", val: false }); continue; }
      if (id === "null")  { toks.push({ type: "NULL", val: null  }); continue; }
      toks.push({ type: "ID", val: id });
      continue;
    }
    // two-char operators first
    const two = s.slice(i, i+2);
    if (two === "&&") { toks.push({ type: "AND",      val: "&&" }); i+=2; continue; }
    if (two === "||") { toks.push({ type: "OR",       val: "||" }); i+=2; continue; }
    if (two === "==") { toks.push({ type: "EQ",       val: "==" }); i+=2; continue; }
    if (two === "!=") { toks.push({ type: "NEQ",      val: "!=" }); i+=2; continue; }
    if (two === ">=") { toks.push({ type: "GTE",      val: ">=" }); i+=2; continue; }
    if (two === "<=") { toks.push({ type: "LTE",      val: "<=" }); i+=2; continue; }
    if (two === "??") { toks.push({ type: "NULLCOAL", val: "??" }); i+=2; continue; }
    // single-char
    switch (s[i]) {
      case "(": toks.push({ type: "LPAREN",  val: "("  }); break;
      case ")": toks.push({ type: "RPAREN",  val: ")"  }); break;
      case "!": toks.push({ type: "BANG",    val: "!"  }); break;
      case ">": toks.push({ type: "GT",      val: ">"  }); break;
      case "<": toks.push({ type: "LT",      val: "<"  }); break;
      case "+": toks.push({ type: "PLUS",    val: "+"  }); break;
      case "-": toks.push({ type: "MINUS",   val: "-"  }); break;
      case "*": toks.push({ type: "STAR",    val: "*"  }); break;
      case "/": toks.push({ type: "SLASH",   val: "/"  }); break;
      case "?": toks.push({ type: "TERNARY", val: "?"  }); break;
      case ":": toks.push({ type: "COLON",   val: ":"  }); break;
      case ".": toks.push({ type: "DOT",     val: "."  }); break;
      // silently skip unknown chars
    }
    i++;
  }
  toks.push({ type: "EOF", val: null });
  return toks;
}

class Parser {
  private pos = 0;
  constructor(
    private toks: Token[],
    private fields: FieldAnswers,
    private ctx: FormContext,
  ) {}

  private peek(): Token { return this.toks[this.pos]; }
  private next(): Token { return this.toks[this.pos++]; }
  private expect(type: TT): Token {
    const t = this.next();
    if (t.type !== type) throw new Error(`Expected ${type}, got ${t.type}`);
    return t;
  }

  parse(): unknown { return this.ternary(); }

  private ternary(): unknown {
    const cond = this.or();
    if (this.peek().type === "TERNARY") {
      this.next();
      const a = this.ternary();
      this.expect("COLON");
      const b = this.ternary();
      return cond ? a : b;
    }
    return cond;
  }

  private or(): unknown {
    let l = this.and();
    while (this.peek().type === "OR") { this.next(); l = l || this.and(); }
    return l;
  }

  private and(): unknown {
    let l = this.nullCoal();
    while (this.peek().type === "AND") { this.next(); l = l && this.nullCoal(); }
    return l;
  }

  private nullCoal(): unknown {
    let l = this.compare();
    while (this.peek().type === "NULLCOAL") { this.next(); l = l ?? this.compare(); }
    return l;
  }

  private compare(): unknown {
    let l = this.add();
    for (;;) {
      const tt = this.peek().type;
      if (tt === "EQ")  { this.next(); l = l === this.add(); }
      else if (tt === "NEQ") { this.next(); l = l !== this.add(); }
      else if (tt === "GT")  { this.next(); l = (l as number) >  (this.add() as number); }
      else if (tt === "GTE") { this.next(); l = (l as number) >= (this.add() as number); }
      else if (tt === "LT")  { this.next(); l = (l as number) <  (this.add() as number); }
      else if (tt === "LTE") { this.next(); l = (l as number) <= (this.add() as number); }
      else break;
    }
    return l;
  }

  private add(): unknown {
    let l = this.mul();
    for (;;) {
      if (this.peek().type === "PLUS")  { this.next(); l = (l as number) + (this.mul() as number); }
      else if (this.peek().type === "MINUS") { this.next(); l = (l as number) - (this.mul() as number); }
      else break;
    }
    return l;
  }

  private mul(): unknown {
    let l = this.unary();
    for (;;) {
      if (this.peek().type === "STAR")  { this.next(); l = (l as number) * (this.unary() as number); }
      else if (this.peek().type === "SLASH") { this.next(); l = (l as number) / (this.unary() as number); }
      else break;
    }
    return l;
  }

  private unary(): unknown {
    if (this.peek().type === "BANG") { this.next(); return !this.unary(); }
    if (this.peek().type === "MINUS") { this.next(); return -(this.unary() as number); }
    return this.primary();
  }

  private primary(): unknown {
    const t = this.peek();
    if (t.type === "NUM")  { this.next(); return t.val; }
    if (t.type === "STR")  { this.next(); return t.val; }
    if (t.type === "BOOL") { this.next(); return t.val; }
    if (t.type === "NULL") { this.next(); return null; }
    if (t.type === "LPAREN") {
      this.next();
      const v = this.ternary();
      this.expect("RPAREN");
      return v;
    }
    if (t.type === "ID") {
      this.next();
      const name = t.val as string;
      // built-in functions
      if (name === "today" && this.peek().type === "LPAREN") {
        this.expect("LPAREN"); this.expect("RPAREN");
        return new Date().toISOString().split("T")[0];
      }
      if (name === "now" && this.peek().type === "LPAREN") {
        this.expect("LPAREN"); this.expect("RPAREN");
        return new Date().toISOString();
      }
      // dot-access chain: fields.x.y  context.k
      let path = [name];
      while (this.peek().type === "DOT") {
        this.next();
        const part = this.expect("ID");
        path.push(part.val as string);
        // skip function call parens if any (e.g. no real functions beyond today/now)
        if (this.peek().type === "LPAREN") {
          this.expect("LPAREN"); this.expect("RPAREN");
        }
      }
      if (path[0] === "fields") {
        return getNestedValue(this.fields as Record<string, unknown>, path.slice(1).join("."));
      }
      if (path[0] === "context") {
        return getNestedValue(this.ctx as Record<string, unknown>, path.slice(1).join("."));
      }
      return undefined;
    }
    return undefined;
  }
}

function safeEvalExpression(
  expression: string,
  fields: FieldAnswers,
  context: FormContext = {}
): unknown {
  try {
    const toks = tokenise(expression);
    const parser = new Parser(toks, fields, context);
    return parser.parse();
  } catch {
    return undefined;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function evaluateCondition(
  condition: ConditionOrRef | undefined | null,
  fields: FieldAnswers,
  namedConditions: Record<string, NamedCondition> = {},
  context: FormContext = {}
): boolean {
  if (!condition) return true;

  if (isRef(condition)) {
    const named = namedConditions[condition.ref];
    if (!named) return true;
    if (named.expression) {
      return Boolean(safeEvalExpression(named.expression, fields, context));
    }
    if (named.condition) return evaluateCondition(named.condition, fields, namedConditions, context);
    return true;
  }
  if (isSimple(condition))      return evalSimple(condition, fields);
  if (isExpression(condition))  return Boolean(safeEvalExpression(condition.expression, fields, context));
  if (isComposite(condition)) {
    if (condition.all) return condition.all.every(c => evaluateCondition(c, fields, namedConditions, context));
    if (condition.any) return condition.any.some(c => evaluateCondition(c, fields, namedConditions, context));
    if (condition.not) return !evaluateCondition(condition.not, fields, namedConditions, context);
  }
  return true;
}

export function evaluateComputed(
  expression: string,
  fields: FieldAnswers,
  context: FormContext = {}
): unknown {
  return safeEvalExpression(expression, fields, context);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  return path.split(".").reduce((acc: unknown, key) => {
    if (acc != null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

// ─── Field validation ─────────────────────────────────────────────────────────
export function validateField(field: FormField, value: unknown, allValues: FieldAnswers): string[] {
  const errors: string[] = [];
  const isEmpty = value == null || value === "" || (Array.isArray(value) && value.length === 0);

  if (isEmpty) {
    if (field.required) {
      errors.push(`${field.label || field.id} is required`);
    } else {
      // A rule-based `required` must still fire on empty values.
      for (const rule of (field.validation?.rules ?? [])) {
        if (rule.type === "required") errors.push(rule.message || `${field.label || field.id} is required`);
      }
    }
    return errors;
  }

  const f = field as unknown as Record<string, unknown>;

  if (f.type === "text" || f.type === "multiline") {
    const str = String(value);
    if (f.min_length != null && str.length < (f.min_length as number))
      errors.push(`Minimum ${f.min_length} characters required`);
    if (f.max_length != null && str.length > (f.max_length as number))
      errors.push(`Maximum ${f.max_length} characters allowed`);
    if (f.pattern) {
      try {
        // Validate regex is safe before using (prevent ReDoS via timeout is not possible
        // in sync code, but we validate the pattern itself)
        const re = new RegExp(f.pattern as string);
        if (!re.test(str)) errors.push((f.pattern_message as string) || "Invalid format");
      } catch { /* invalid regex — skip */ }
    }
  }

  if (f.type === "number") {
    const num = parseFloat(String(value));
    if (isNaN(num)) { errors.push("Must be a valid number"); return errors; }
    if (!f.signed && num < 0) errors.push("Negative values not allowed");
    if (f.min != null && num < (f.min as number)) errors.push(`Minimum value is ${f.min}`);
    if (f.max != null && num > (f.max as number)) errors.push(`Maximum value is ${f.max}`);
  }

  if (f.type === "multiselect" && Array.isArray(value)) {
    if (f.min_selected != null && value.length < (f.min_selected as number))
      errors.push(`Select at least ${f.min_selected} options`);
    if (f.max_selected != null && value.length > (f.max_selected as number))
      errors.push(`Select at most ${f.max_selected} options`);
  }

  for (const rule of (field.validation?.rules ?? [])) {
    const v = rule.value;
    const msg = rule.message;
    if (rule.type === "required" && isEmpty) { errors.push(msg || "Required"); }
    else if (rule.type === "min_length" && String(value).length < Number(v))
      errors.push(msg || `Min ${v} characters`);
    else if (rule.type === "max_length" && String(value).length > Number(v))
      errors.push(msg || `Max ${v} characters`);
    else if (rule.type === "regex") {
      try {
        if (!new RegExp(String(v)).test(String(value))) errors.push(msg || "Invalid format");
      } catch { /* skip invalid regex */ }
    }
    else if (rule.type === "min" && parseFloat(String(value)) < Number(v))
      errors.push(msg || `Min ${v}`);
    else if (rule.type === "max" && parseFloat(String(value)) > Number(v))
      errors.push(msg || `Max ${v}`);
    else if (rule.type === "expression" && rule.expression) {
      const pass = safeEvalExpression(rule.expression, allValues);
      if (!pass) errors.push(msg || "Validation failed");
    }
  }

  return errors;
}
