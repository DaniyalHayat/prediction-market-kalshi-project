import {useMemo, type ReactNode} from 'react'
import {
  Badge, Button, createTableColumn, DataGrid, DataGridBody, DataGridCell, DataGridHeader,
  DataGridHeaderCell, DataGridRow, type TableColumnDefinition,
} from '@fluentui/react-components'
import type {ReviewSummary} from './reviews'
import {describeRule, ruleApplies, type ReviewRow, type Rule} from './rules'

const dates = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
})
const numbers = new Intl.NumberFormat(undefined, {maximumFractionDigits: 2})
export const capturedDate = (value: string) => dates.format(new Date(value))
const number = (value: number) => numbers.format(value)
const label = (value: string) => value.replace(/_/g, ' ')

export function StatusBadge({status}: {status: string}) {
  const appearance = status === 'pass' ? {text: 'Passed', color: 'success'} as const :
    status === 'fail' ? {text: 'Failed', color: 'danger'} as const :
    {text: 'Unavailable', color: 'warning'} as const
  return <Badge appearance="tint" shape="rounded" color={appearance.color}>{appearance.text}</Badge>
}

function Grid<T extends {id: string}>({items, columns, name}: {
  items: T[]
  columns: TableColumnDefinition<T>[]
  name: string
}) {
  return <div className="grid-scroll">
    <DataGrid aria-label={name} items={items} columns={columns} getRowId={(item: T) => item.id} focusMode="cell">
      <DataGridHeader>
        <DataGridRow>{({renderHeaderCell}) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}</DataGridRow>
      </DataGridHeader>
      <DataGridBody<T>>
        {({item, rowId}) => <DataGridRow<T> key={rowId}>
          {({renderCell}) => <DataGridCell>{renderCell(item)}</DataGridCell>}
        </DataGridRow>}
      </DataGridBody>
    </DataGrid>
  </div>
}

function column<T>(id: string, title: string, renderCell: (item: T) => ReactNode) {
  return createTableColumn<T>({columnId: id, renderHeaderCell: () => title, renderCell})
}

export function ReviewArchive({items, disabled, selected, open}: {
  items: ReviewSummary[]
  disabled: boolean
  selected?: string
  open: (id: string) => void
}) {
  const columns = useMemo(() => [
    column<ReviewSummary>('title', 'Review', item => (
      <Button appearance={item.id === selected ? 'primary' : 'subtle'} size="small" disabled={disabled}
        onClick={() => open(item.id)} aria-label={`Open ${item.title}`} aria-current={item.id === selected}>
        {item.title}
      </Button>
    )),
    column<ReviewSummary>('status', 'Status', item => <StatusBadge status={item.status} />),
    column<ReviewSummary>('captured_at', 'Captured', item => <time dateTime={item.captured_at}>{capturedDate(item.captured_at)}</time>),
    column<ReviewSummary>('check_count', 'Readings', item => number(item.check_count)),
  ], [disabled, open, selected])
  return <Grid items={items} columns={columns} name="Saved operations reviews" />
}

export function ReviewReadings({items, rules}: {items: ReviewRow[]; rules: Rule[]}) {
  const columns = useMemo(() => [
    column<ReviewRow>('check', 'Connector and check', row => <div className="reading-label">
      <span>{label(row.check)}</span>
      <small>{label(row.connector)}{row.measurement.dimension && ' · ' + row.measurement.dimension}</small>
    </div>),
    column<ReviewRow>('status', 'Status', row => <StatusBadge status={row.status} />),
    column<ReviewRow>('observed', 'Observed', row => {
      const observed = row.measurement.value
      return <div className="reading-label">
        {observed != null && <span>{typeof observed === 'number' ? number(observed) : observed}{row.measurement.unit && ' ' + row.measurement.unit}</span>}
        {row.timing.latency_ms != null && <span>{number(row.timing.latency_ms)} ms</span>}
        {row.response.status_code != null && <small>HTTP {row.response.status_code}</small>}
        {row.measurement.sample_count != null && <small>{number(row.measurement.sample_count)} samples</small>}
        {observed == null && row.timing.latency_ms == null && row.response.status_code == null &&
          row.measurement.sample_count == null && <small>No numeric reading</small>}
      </div>
    }),
    column<ReviewRow>('rules', 'Review flags', row => {
      const matching = rules.filter(rule => ruleApplies(rule, row))
      return matching.length
        ? <div className="rule-matches">{matching.map(rule => <Badge key={describeRule(rule)} shape="rounded" appearance="tint" color="warning">
          {describeRule(rule)}
        </Badge>)}</div>
        : <small>None</small>
    }),
  ], [rules])
  return <Grid items={items} columns={columns} name="Connector readings" />
}
