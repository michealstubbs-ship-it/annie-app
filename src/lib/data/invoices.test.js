import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock, rpcMock } = vi.hoisted(() => ({ fromMock: vi.fn(), rpcMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock, rpc: rpcMock } }))

import { listInvoices, listInvoicesForCompany, listInvoicesForJob, getInvoice, createInvoice, updateInvoice, replaceLineItems, deleteInvoice, markInvoicePaid, voidInvoice, markInvoiceSent, triggerRebate, clearRebateTrigger } from './invoices.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    order: vi.fn(chain),
    insert: vi.fn(chain),
    update: vi.fn(chain),
    delete: vi.fn(chain),
    maybeSingle: vi.fn(chain),
    single: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

let builder

beforeEach(() => {
  vi.clearAllMocks()
  builder = makeBuilder({ data: null, error: null })
  fromMock.mockReturnValue(builder)
  rpcMock.mockResolvedValue({ data: 'INV-2026-0042', error: null })
})

describe('listInvoices', () => {
  it('joins company/job/candidate names, team-scoped by RLS, newest first', async () => {
    builder = makeBuilder({ data: [{ id: 'inv1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listInvoices()
    expect(fromMock).toHaveBeenCalledWith('invoices')
    expect(builder.select).toHaveBeenCalledWith('*, companies(name), jobs(title), candidates(name)')
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'inv1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listInvoices()).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listInvoices()).rejects.toEqual({ message: 'db down' })
  })
})

// 2026-09-08, gap-analysis batch 9 ("invoices don't show up on the job or
// company they're for")
describe('listInvoicesForCompany', () => {
  it('filters to the given company, joins job title and candidate name, newest first', async () => {
    builder = makeBuilder({ data: [{ id: 'inv1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listInvoicesForCompany('co1')
    expect(fromMock).toHaveBeenCalledWith('invoices')
    expect(builder.select).toHaveBeenCalledWith('*, jobs(title), candidates(name)')
    expect(builder.eq).toHaveBeenCalledWith('company_id', 'co1')
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'inv1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listInvoicesForCompany('co1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listInvoicesForCompany('co1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listInvoicesForJob', () => {
  it('filters to the given job, joins candidate name, newest first', async () => {
    builder = makeBuilder({ data: [{ id: 'inv1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listInvoicesForJob('job1')
    expect(fromMock).toHaveBeenCalledWith('invoices')
    expect(builder.select).toHaveBeenCalledWith('*, candidates(name)')
    expect(builder.eq).toHaveBeenCalledWith('job_id', 'job1')
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'inv1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listInvoicesForJob('job1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listInvoicesForJob('job1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('getInvoice', () => {
  it('joins the job fee_value and every line item, targets by id', async () => {
    builder = makeBuilder({ data: { id: 'inv1' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await getInvoice('inv1')
    expect(builder.select).toHaveBeenCalledWith('*, companies(name), jobs(title, fee_value), candidates(name), invoice_line_items(*)')
    expect(builder.eq).toHaveBeenCalledWith('id', 'inv1')
    expect(result).toEqual({ id: 'inv1' })
  })

  it('throws instead of silently returning null when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(getInvoice('inv1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('createInvoice', () => {
  it('stamps the given user_id onto the invoice row and inserts line items scoped to the new invoice id', async () => {
    const invoiceBuilder = makeBuilder({ data: { id: 'inv1' }, error: null })
    const lineItemsBuilder = makeBuilder({ data: null, error: null })
    fromMock.mockImplementation(table => table === 'invoices' ? invoiceBuilder : lineItemsBuilder)

    const result = await createInvoice({ bill_to_name: 'Acme' }, [{ description: 'Fee', quantity: 1, unitAmount: 100, amount: 100 }], 'user_1')

    expect(invoiceBuilder.insert).toHaveBeenCalledWith({ bill_to_name: 'Acme', user_id: 'user_1' })
    expect(lineItemsBuilder.insert).toHaveBeenCalledWith([
      { invoice_id: 'inv1', description: 'Fee', quantity: 1, unit_amount: 100, amount: 100, sort_order: 0 },
    ])
    expect(result).toEqual({ id: 'inv1' })
  })

  it('does not attempt a line-item insert when no line items are given', async () => {
    const invoiceBuilder = makeBuilder({ data: { id: 'inv1' }, error: null })
    const lineItemsBuilder = makeBuilder({ data: null, error: null })
    fromMock.mockImplementation(table => table === 'invoices' ? invoiceBuilder : lineItemsBuilder)

    await createInvoice({ bill_to_name: 'Acme' }, [], 'user_1')
    expect(lineItemsBuilder.insert).not.toHaveBeenCalled()
  })

  it('throws if the invoice insert itself fails, before ever attempting line items', async () => {
    const invoiceBuilder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(invoiceBuilder)
    await expect(createInvoice({ bill_to_name: 'Acme' }, [], 'user_1')).rejects.toEqual({ message: 'db down' })
  })

  it('throws if the line-item insert fails, even though the invoice row was already created', async () => {
    const invoiceBuilder = makeBuilder({ data: { id: 'inv1' }, error: null })
    const lineItemsBuilder = makeBuilder({ data: null, error: { message: 'line item db down' } })
    fromMock.mockImplementation(table => table === 'invoices' ? invoiceBuilder : lineItemsBuilder)
    await expect(createInvoice({ bill_to_name: 'Acme' }, [{ description: 'Fee', quantity: 1, unitAmount: 100, amount: 100 }], 'user_1'))
      .rejects.toEqual({ message: 'line item db down' })
  })
})

describe('updateInvoice', () => {
  it('targets the row by id', async () => {
    builder = makeBuilder({ data: { id: 'inv1', status: 'sent' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await updateInvoice('inv1', { status: 'sent' })
    expect(builder.update).toHaveBeenCalledWith({ status: 'sent' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'inv1')
    expect(result).toEqual({ id: 'inv1', status: 'sent' })
  })

  it('throws instead of silently succeeding when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(updateInvoice('inv1', { status: 'sent' })).rejects.toEqual({ message: 'db down' })
  })
})

describe('replaceLineItems', () => {
  it('deletes every existing line item for the invoice, then inserts the new ones in order', async () => {
    await replaceLineItems('inv1', [{ description: 'A', quantity: 1, unitAmount: 50, amount: 50 }, { description: 'B', quantity: 2, unitAmount: 25, amount: 50 }])
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('invoice_id', 'inv1')
    expect(builder.insert).toHaveBeenCalledWith([
      { invoice_id: 'inv1', description: 'A', quantity: 1, unit_amount: 50, amount: 50, sort_order: 0 },
      { invoice_id: 'inv1', description: 'B', quantity: 2, unit_amount: 25, amount: 50, sort_order: 1 },
    ])
  })

  it('does not insert anything when the new line items array is empty', async () => {
    await replaceLineItems('inv1', [])
    expect(builder.insert).not.toHaveBeenCalled()
  })

  it('throws if the delete fails, before attempting the insert', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(replaceLineItems('inv1', [{ description: 'A', quantity: 1, unitAmount: 50, amount: 50 }])).rejects.toEqual({ message: 'db down' })
  })
})

describe('deleteInvoice', () => {
  it('targets the row by id', async () => {
    await deleteInvoice('inv1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'inv1')
  })

  it('throws instead of silently succeeding when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(deleteInvoice('inv1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('markInvoicePaid', () => {
  it('sets status to paid and stamps paid_at', async () => {
    await markInvoicePaid('inv1')
    expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'paid', paid_at: expect.any(String) }))
    expect(builder.eq).toHaveBeenCalledWith('id', 'inv1')
  })
})

describe('voidInvoice', () => {
  it('sets status to void', async () => {
    await voidInvoice('inv1')
    expect(builder.update).toHaveBeenCalledWith({ status: 'void' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'inv1')
  })
})

describe('markInvoiceSent', () => {
  it('claims the permanent invoice number via the atomic RPC, then sets status to sent with that number and stamps sent_at', async () => {
    await markInvoiceSent('inv1')
    expect(rpcMock).toHaveBeenCalledWith('claim_invoice_number', { p_invoice_id: 'inv1' })
    expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({ invoice_number: 'INV-2026-0042', status: 'sent', sent_at: expect.any(String) }))
    expect(builder.eq).toHaveBeenCalledWith('id', 'inv1')
  })

  it('never emails anything — this is a pure data update, no fetch/network call of its own', async () => {
    // Nothing to assert against a fetch mock here by design: markInvoiceSent
    // only ever touches supabase.rpc/from, unlike sendInvoice() in
    // invoiceApi.js which POSTs to send-invoice.js. This test exists so a
    // future change that reaches for fetch() here gets caught immediately.
    await markInvoiceSent('inv1')
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it('throws instead of silently succeeding when the invoice-number claim fails', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'not authorized' } })
    await expect(markInvoiceSent('inv1')).rejects.toEqual({ message: 'not authorized' })
    expect(builder.update).not.toHaveBeenCalled()
  })

  it('throws instead of silently succeeding when the status update itself fails', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(markInvoiceSent('inv1')).rejects.toEqual({ message: 'db down' })
  })
})

// 2026-09-03, Michael ("rebate/guarantee period tracking")
describe('triggerRebate', () => {
  it('stamps rebate_triggered_at and rebate_notes', async () => {
    await triggerRebate('inv1', 'Candidate resigned week 8', '2026-09-01')
    expect(builder.update).toHaveBeenCalledWith({ rebate_triggered_at: '2026-09-01', rebate_notes: 'Candidate resigned week 8' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'inv1')
  })

  it('defaults the triggered date to today when not given', async () => {
    await triggerRebate('inv1', 'Left early')
    const call = builder.update.mock.calls[0][0]
    expect(call.rebate_triggered_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('stores null notes rather than an empty string when none given', async () => {
    await triggerRebate('inv1', '', '2026-09-01')
    expect(builder.update).toHaveBeenCalledWith({ rebate_triggered_at: '2026-09-01', rebate_notes: null })
  })

  it('throws instead of silently succeeding when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(triggerRebate('inv1', 'note', '2026-09-01')).rejects.toEqual({ message: 'db down' })
  })
})

describe('clearRebateTrigger', () => {
  it('clears both rebate fields back to null', async () => {
    await clearRebateTrigger('inv1')
    expect(builder.update).toHaveBeenCalledWith({ rebate_triggered_at: null, rebate_notes: null })
    expect(builder.eq).toHaveBeenCalledWith('id', 'inv1')
  })
})
