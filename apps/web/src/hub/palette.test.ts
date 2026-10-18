import { describe, expect, it } from 'vitest'
import { scopeQuery } from './palette'

describe('scopeQuery', () => {
  it('takes a module operator out of the query', () => {
    expect(scopeQuery('in:tasks rent')).toEqual({ group: 'tasks', text: 'rent' })
    expect(scopeQuery('lease in:docs pdf')).toEqual({ group: 'docs', text: 'lease pdf' })
    expect(scopeQuery('IN:Mail')).toEqual({ group: 'mail', text: '' })
  })
  it("leaves mail's own operators alone", () => {
    expect(scopeQuery(' in:inbox from:ana ')).toEqual({ group: null, text: 'in:inbox from:ana' })
    expect(scopeQuery('in:tasksy')).toEqual({ group: null, text: 'in:tasksy' })
  })
})
