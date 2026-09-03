// 2026-09-06, gap-analysis batch 2 ("real Boolean / X-ray search"):
// Candidates.jsx's plain search (searchCandidates in candidatesView.js) is
// a substring match with no AND/OR/NOT/phrase support — fine for "find the
// one candidate named Zara", useless for "python AND (django OR flask) NOT
// contractor" the way a recruiter actually searches a large database. This
// is additive (a "Boolean mode" toggle in Candidates.jsx), never a
// replacement — the existing simple search stays the default.
//
// Grammar (standard precedence: NOT > AND > OR, AND is also implicit
// between two terms with no operator between them — "python developer"
// means python AND developer, same convention every X-ray/Boolean search
// tool uses):
//   expr   := term (OR term)*
//   term   := factor (AND? factor)*        (AND is optional/implicit)
//   factor := NOT factor | '(' expr ')' | PHRASE | WORD

function tokenize(query) {
  const tokens = []
  // Word chars exclude '(' and ')' explicitly — plain \S+ would greedily
  // swallow a trailing/leading paren with no space next to it (e.g.
  // "django)" as one token), silently hiding the rparen from the parser.
  const re = /"([^"]*)"|(\(|\))|([^\s()]+)/g
  let m
  while ((m = re.exec(query))) {
    if (m[1] !== undefined) tokens.push({ type: 'phrase', value: m[1].toLowerCase() })
    else if (m[2]) tokens.push({ type: m[2] === '(' ? 'lparen' : 'rparen' })
    else {
      const word = m[3]
      const upper = word.toUpperCase()
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ type: upper.toLowerCase() })
      else tokens.push({ type: 'word', value: word.toLowerCase() })
    }
  }
  return tokens
}

// Recursive-descent parser producing a small AST: { op: 'and'|'or'|'not', a, b? } or { op: 'term', value }.
function parse(tokens) {
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  function parseExpr() {
    let node = parseTerm()
    while (peek()?.type === 'or') {
      next()
      node = { op: 'or', a: node, b: parseTerm() }
    }
    return node
  }

  function parseTerm() {
    let node = parseFactor()
    while (peek() && peek().type !== 'or' && peek().type !== 'rparen') {
      if (peek().type === 'and') next()
      node = { op: 'and', a: node, b: parseFactor() }
    }
    return node
  }

  function parseFactor() {
    const tok = peek()
    if (!tok) return { op: 'term', value: '' }
    if (tok.type === 'not') {
      next()
      return { op: 'not', a: parseFactor() }
    }
    if (tok.type === 'lparen') {
      next()
      const node = parseExpr()
      if (peek()?.type === 'rparen') next()
      return node
    }
    next()
    return { op: 'term', value: tok.value || '' }
  }

  if (!tokens.length) return null
  return parseExpr()
}

function evaluate(node, haystack) {
  if (!node) return true
  switch (node.op) {
    case 'term': return node.value ? haystack.includes(node.value) : true
    case 'not': return !evaluate(node.a, haystack)
    case 'and': return evaluate(node.a, haystack) && evaluate(node.b, haystack)
    case 'or': return evaluate(node.a, haystack) || evaluate(node.b, haystack)
    default: return true
  }
}

// Exported for the Candidates.jsx "Boolean mode" toggle — parsing a
// malformed query (unbalanced parens, a trailing operator) never throws;
// the recursive-descent parser above always terminates with best-effort
// tokens rather than needing a separate validity check.
export function parseBooleanQuery(query) {
  return parse(tokenize(query || ''))
}

// Same searchable-field set as searchCandidates in candidatesView.js
// (name/role/company/location/industry/nationality/notes), plus the
// AI-inferred titles/industries arrays already used for match-scoring
// (candidateMatch.js) — a Boolean search benefits from the same broader
// surface a recruiter would expect "python" to hit even when it's only in
// Annie's own inferred titles, not the literal role field.
function candidateHaystack(c) {
  const parts = [c.name, c.role, c.company, c.location, c.industry, c.nationality, c.notes, ...(c.titles || []), ...(c.industries || [])]
  return parts.filter(Boolean).join(' ').toLowerCase()
}

export function searchCandidatesBoolean(candidates, query) {
  const ast = parseBooleanQuery(query)
  if (!ast) return candidates
  return candidates.filter(c => evaluate(ast, candidateHaystack(c)))
}
