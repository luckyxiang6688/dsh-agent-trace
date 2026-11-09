import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relatedTicketLabel } from '../src/client/labels.ts'

test('关联工单文案：同来源不标，跨来源标出来源，id 只给前 8 位', () => {
  const ticket = { ticketId: 'c5faef17fff20441f4b105b70f265c13', title: '整理目录' }
  assert.equal(relatedTicketLabel({ ...ticket, source: 'fixture' }, 'fixture'), '整理目录 · c5faef17')
  // 跨来源必须标：左栏按来源过滤，不标会让人以为它在当前来源下
  assert.equal(relatedTicketLabel({ ...ticket, source: 'demo' }, 'fixture'), '整理目录 · c5faef17 · 来源 demo')
  // 来源没记录时不编：既不写「来源 undefined」，也不假装就是当前来源
  assert.equal(relatedTicketLabel(ticket, 'fixture'), '整理目录 · c5faef17')
  // 标题缺失时给「工单」，不留空按钮
  assert.equal(relatedTicketLabel({ ticketId: 'abc', source: 'demo' }, 'fixture'), '工单 · abc · 来源 demo')
})
