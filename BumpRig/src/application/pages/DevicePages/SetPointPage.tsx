import * as React from 'react'
import { useCallback, useState, useMemo, useEffect } from 'react'
import { RouteComponentProps } from '@reach/router'
import { ButtonGroup, Card, Icon, NumericInput, Intent, Tree, TreeNodeInfo, TreeEventHandler } from '@blueprintjs/core'
import { ChartContainer, LineChart, RealTimeDomain, VerticalAxis, TimeAxis } from '@electricui/charts'
import { MessageDataSource } from '@electricui/core-timeseries'
import { useDeviceID, useSendMessage, IntervalRequester, useHardwareState } from '@electricui/components-core'
import { Slider } from '@electricui/components-desktop-blueprint'
import { OPEN_DIALOG_IPC_EVENT } from '@electricui/utility-electron'
import { ipcRenderer, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { Button, Callout, ProgressBar } from '@blueprintjs/core'
import classnames from 'classnames'
import { parse } from 'csv/sync'
import { readFileSync } from 'fs'
import { IconNames } from '@blueprintjs/icons'
import { Composition } from 'atomic-layout'

// Add the `csv` package to package.json
import './tree-caret-override.css'
import { CancellationToken, Message } from '@electricui/core'

const ledStateDataSource = new MessageDataSource<number>('led_state')

/**
 * Full width file picker
 */
function FilePicker(props: { onSelected: (filepath: string | null) => void; currentSelection: string | null }) {
  const pathPicker = useCallback(() => {
    const options: OpenDialogOptions = {
      filters: [{ name: '.csv', extensions: ['csv'] }],
      message: 'Select a Setpoint file',
      properties: ['openFile'],
    }

    ipcRenderer.invoke(OPEN_DIALOG_IPC_EVENT, options).then((result: OpenDialogReturnValue) => {
      props.onSelected(null) // Reset it first
      props.onSelected(result.filePaths[0])
    })
  }, [props.onSelected])

  return (
    <div className="bp3-file-input bp3-fill .modifier" onClick={pathPicker}>
      <input type="file" />
      <span
        className={classnames({
          'bp3-file-input-has-selection': Boolean(props.currentSelection),
          'bp3-file-upload-input': true,
        })}
      >
        {props.currentSelection ?? 'Open file'}
      </span>
    </div>
  )
}

type CSVRow = {
  time: number // in milliseconds
  setPoint: number
}

function calcTimeDiffFromPrevious(rows: CSVRow[], index: number) {
  const previousTime = index === 0 ? 0 : rows[index - 1].time
  const currentTime = rows[index].time

  return Math.abs(currentTime - previousTime)
}

function calcTimeDiffToNext(rows: CSVRow[], index: number) {
  const nextIndex = (index + 1) % rows.length

  const currentTime = rows[index].time
  const nextTime = rows[nextIndex].time

  return nextTime - currentTime
}

function DataViewer(props: { data: CSVRow[]; setErrorMessage: (errorMessage: string) => void }) {
  const [isRunning, setIsRunning] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [remainingRepeats, setRemainingRepeats] = useState(0)
  const [totalLoopIterations, setTotalLoopIterations] = useState(0)

  const sendMessage = useSendMessage()

  useEffect(() => {
    // Don't do anything if we're not running
    if (!isRunning) {
      return
    }

    const row = props.data[activeIndex]

    // Send message
    const message = new Message('lit_time', row.setPoint)
    message.metadata.ack = true // ack this message

    // Create a cancellation token that ends in 1 second, don't cancel on unmount, otherwise
    // the last set point will never reach the hardware
    const cancellationToken = new CancellationToken(`set point iteration ${activeIndex}`).deadline(1000)

    sendMessage(message, cancellationToken).catch(err => {
      if (cancellationToken.caused(err)) {
        // We cancelled
      } else {
        props.setErrorMessage(`Failed to send message: ${err.message ? err.message : 'unknown reason'}`)
      }
    })

    // Set timer to change index
    const timer = setTimeout(() => {
      const nextIndex = (activeIndex + 1) % props.data.length

      // If the next index is 0
      if (nextIndex === 0) {
        // If there are no more repeats, stop, don't increment the index
        if (remainingRepeats === 0) {
          setIsRunning(false)
          return
        }

        // Otherwise decrement our remaining repeats, there will be at least one
        setRemainingRepeats(remainingRepeats - 1)
      }

      // Increment the index once our timer fires
      setActiveIndex(nextIndex)

      // The use effect handler will fire again
    }, calcTimeDiffToNext(props.data, activeIndex))

    // On dismount of the component
    return () => {
      // Clear any active timer
      clearTimeout(timer)
    }
  }, [props.data, isRunning, activeIndex, remainingRepeats])

  const activeIndexColor = isRunning ? Intent.SUCCESS : Intent.WARNING
  const lastIndexColor = isRunning ? Intent.DANGER : Intent.NONE

  const currentOverallIndex = activeIndex + (totalLoopIterations - remainingRepeats - 1) * props.data.length
  const totalPoints = totalLoopIterations * props.data.length
  const progress = !isRunning ? 0 : currentOverallIndex / totalPoints

  const treeData: TreeNodeInfo[] = props.data.map((row, index) => ({
    id: index,
    label: `Interval: ${row.setPoint}ms`,
    icon: (
      <Icon
        icon={IconNames.DOT}
        intent={
          index === activeIndex
            ? activeIndexColor
            : index === props.data.length - 1 && remainingRepeats === 0
            ? lastIndexColor
            : Intent.NONE
        }
      />
    ),
    secondaryLabel: (
      <>
        <Icon icon={IconNames.SMALL_PLUS} />
        {calcTimeDiffFromPrevious(props.data, index)}ms
      </>
    ),
    hasCaret: false,
  }))

  const onClick: TreeEventHandler = useCallback(
    (node, path, e) => {
      if (isRunning) return
      const nodeIndex = node.id as number
      setActiveIndex(nodeIndex)
    },
    [isRunning],
  )

  return (
    <div
      style={{ marginTop: '1em', background: 'rgba(0,0,0,0.1)', border: '1px solid rgba(0,0,0,0.2)', borderRadius: 3 }}
    >
      <div style={{ overflowY: 'auto' }}>
        <Tree contents={treeData} className="caret-less-tree" onNodeClick={onClick} />
      </div>
      <ButtonGroup fill>
        {isRunning ? (
          <Button
            icon={IconNames.PAUSE}
            intent={Intent.PRIMARY}
            onClick={() => setIsRunning(false)}
            style={{ width: '50%' }}
          >
            Pause
          </Button>
        ) : (
          <>
            <Button
              icon={IconNames.PLAY}
              intent={Intent.SUCCESS}
              onClick={() => {
                setIsRunning(true)
                setTotalLoopIterations(remainingRepeats + 1)
              }}
              style={{ width: '25%' }}
              disabled={activeIndex === props.data.length - 1 && remainingRepeats === 0}
            >
              Start
            </Button>
            <Button
              icon={IconNames.RESET}
              intent={Intent.WARNING}
              onClick={() => {
                setActiveIndex(0)
              }}
              style={{ width: '25%' }}
              disabled={activeIndex === 0}
            >
              Reset
            </Button>
          </>
        )}

        <NumericInput
          value={remainingRepeats}
          onValueChange={setRemainingRepeats}
          leftIcon={IconNames.REPEAT}
          min={0}
        />
      </ButtonGroup>
      <ProgressBar
        value={progress}
        animate={false}
        intent={Intent.PRIMARY}
        stripes={false}
        key={`${isRunning ? 'r' : 'nr'}${totalLoopIterations}`} // Re-mount the div component when we finish so it doesn't animate from 100% to 0%, it looks strange
      />
    </div>
  )
}

function DataInjestor() {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // This is a synchronous callback but it shouldn't take very long to load the data
  const parsedData = useMemo(() => {
    if (!selectedFilePath) {
      return null
    }

    const validData: CSVRow[] = []

    // Read the file, parse it
    try {
      // If this becomes a significant amount of data, should do this asynchronously
      const contents = readFileSync(selectedFilePath)
      const parsed = parse(contents, { columns: ['time', 'set_point'] })

      for (let index = 0; index < parsed.length; index++) {
        const row = parsed[index]

        if (index === 0 && row.time === 'time' && row.set_point === 'set_point') {
          // This is the header, continue without error
          continue
        }

        // Parse the strings to numbers
        const time = parseInt(row.time)
        const setPoint = parseFloat(row.set_point)

        // Validate each piece of data and push to our validated array
        if (Number.isInteger(time) && Number.isFinite(setPoint)) {
          validData.push({
            time,
            setPoint,
          })
          continue
        }

        throw new Error(`Error reading CSV at index ${index}, row: ${JSON.stringify(row)}`)
      }

      // A successful parse wipes the error message
      setErrorMessage(null)

      return validData
    } catch (err) {
      if (err.code === 'ENOENT') {
        setErrorMessage(`File not found: ${selectedFilePath}`)
      } else if (err.code === 'EACCES') {
        setErrorMessage(`Permission denied to read file: ${selectedFilePath}`)
      } else {
        setErrorMessage(`An unknown error occurred while reading the file: ${err.message}`)
      }

      return null
    }
  }, [selectedFilePath])

  return (
    <>
      <FilePicker onSelected={setSelectedFilePath} currentSelection={selectedFilePath} />

      {errorMessage ? (
        <Callout intent={Intent.WARNING} title="Error processing file" style={{ marginTop: '1em' }}>
          {errorMessage}
        </Callout>
      ) : null}

      {parsedData ? <DataViewer data={parsedData} setErrorMessage={setErrorMessage} /> : null}
    </>
  )
}

export const SetPointPage = (props: RouteComponentProps) => {
  const deviceID = useDeviceID()

  return (
    <Composition templateCols="1fr 1.25fr" gap={10} templateRows="1fr">
      <Card>
        <DataInjestor />
      </Card>
      <div>
        <Card>
          <IntervalRequester variables={['led_state']} interval={100} />
          <div style={{ textAlign: 'center', marginBottom: '1em' }}>
            <b>LED State</b> {deviceID}
          </div>
          <ChartContainer height={300}>
            <LineChart dataSource={ledStateDataSource} />
            <RealTimeDomain window={10000} yMin={-1} yMax={2} />
            <TimeAxis />
            <VerticalAxis />
          </ChartContainer>
        </Card>
        <Card style={{ marginTop: 10 }}>
          <div>LED Interval</div>
          <div style={{ margin: 20 }}>
            <Slider min={0} max={1000} stepSize={5} labelStepSize={100}>
              <Slider.Handle accessor="lit_time" />
            </Slider>
          </div>
        </Card>
      </div>
    </Composition>
  )
}
