import { Span, SpanStatusCode } from '@opentelemetry/api'
import { removeUndefinedProperties, setSpanStatus } from '../src/main'

jest.mock('@opentelemetry/api')

const mockSetStatus = jest.fn()

// Mock of Span object
const span = {
  setStatus: mockSetStatus
}

describe('Set Span Status', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  test('sets the status as OK when success is true', () => {
    setSpanStatus(span as unknown as Span, true)
    expect(mockSetStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.OK,
      message: 'OK'
    })
  })

  test('sets the status as ERROR when success is false', () => {
    setSpanStatus(span as unknown as Span, false)
    expect(mockSetStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'ERROR'
    })
  })
})

describe('Remove Undefined Properties', () => {
  test('removes undefined properties from an object', () => {
    const obj = {
      property1: 'value1',
      property2: undefined,
      property3: 'value3'
    }
    const resultObj = removeUndefinedProperties(obj)
    expect(resultObj).toEqual({ property1: 'value1', property3: 'value3' })
  })
})
