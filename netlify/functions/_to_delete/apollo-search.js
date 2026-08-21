// Turns a company name plus likely job titles into a real, verified contact via Apollo.
// Called after Annie has already sourced a lead, only to find the actual person.
export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) {
    // Apollo not configured yet, degrade gracefully rather than breaking the sourcing flow
    return new Response(JSON.stringify({ matches: [], configured: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { company, titleKeywords } = await req.json()
    if (!company) {
      return new Response(JSON.stringify({ error: 'company is required', matches: [] }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    const resp = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        q_organization_name: company,
        person_titles: Array.isArray(titleKeywords) && titleKeywords.length ? titleKeywords : undefined,
        page: 1,
        per_page: 3,
      }),
    })

    if (!resp.ok) {
      // Degrade gracefully, sourcing still works, just without a verified name
      return new Response(JSON.stringify({ matches: [], configured: true, error: `Apollo returned ${resp.status}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const data = await resp.json()
    const matches = (data.people || []).slice(0, 3).map(p => ({
      name: [p.first_name, p.last_name].filter(Boolean).join(' ').trim(),
      title: p.title || '',
      linkedin_url: p.linkedin_url || '',
      company: p.organization?.name || company,
    })).filter(m => m.name)

    return new Response(JSON.stringify({ matches, configured: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ matches: [], error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export const config = { path: '/api/apollo-search' }
