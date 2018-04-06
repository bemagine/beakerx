/*
 *  Copyright 2018 TWO SIGMA OPEN SOURCE, LLC
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

import {CellRenderer, DataGrid, DataModel, GraphicsContext} from "@phosphor/datagrid";
import { BeakerxDataGridModel } from "./model/BeakerxDataGridModel";
import { Widget } from "@phosphor/widgets";
import { Signal } from '@phosphor/signaling';
import { ICellData } from "./interface/ICell";
import { CellRendererFactory } from "./cell/CellRendererFactory";
import DataGridColumn from "./column/DataGridColumn";
import IDataModelState from "./interface/IDataGridModelState";
import HighlighterManager from "./highlighter/HighlighterManager";
import IHihglighterState from "./interface/IHighlighterState";
import ColumnManager from "./column/ColumnManager";
import RowManager from "./row/RowManager";
import CellSelectionManager from "./cell/CellSelectionManager";
import CellManager from "./cell/CellManager";
import {DataGridHelpers} from "./dataGridHelpers";
import EventManager from "./event/EventManager";
import { IMessageHandler, Message, MessageLoop } from '@phosphor/messaging';
import CellFocusManager from "./cell/CellFocusManager";
import {
  DEFAULT_GRID_BORDER_WIDTH,
  DEFAULT_GRID_PADDING, DEFAULT_ROW_HEIGHT,
  MIN_COLUMN_WIDTH
} from "./style/dataGridStyle";
import CellTooltipManager from "./cell/CellTooltipManager";
import * as bkUtils from '../../shared/bkUtils';
import getStringSize = DataGridHelpers.getStringSize;
import {BeakerxDataStore} from "./store/dataStore";
import {
  selectCellHighlighters, selectDataFontSize,
  selectHasIndex, selectHeaderFontSize, selectHeadersVertical,
  selectTooltips,
  selectValues
} from "./model/selectors";
import {selectColumnWidth} from "./column/selectors";
import throttle = DataGridHelpers.throttle;
import DataGridCell from "./cell/DataGridCell";
import {COLUMN_TYPES} from "./column/enums";
import disableKeyboardManager = DataGridHelpers.disableKeyboardManager;
import enableKeyboardManager = DataGridHelpers.enableKeyboardManager;
import ColumnPosition from "./column/ColumnPosition";
import {SectionList} from "@phosphor/datagrid/lib/sectionlist";
import ColumnRegion = DataModel.ColumnRegion;
import CellRegion = DataModel.CellRegion;

export class BeakerxDataGrid extends DataGrid {
  id: string;
  store: BeakerxDataStore;
  columnSections: SectionList;
  columnHeaderSections: SectionList;
  model: BeakerxDataGridModel;
  rowHeaderSections: SectionList;
  rowSections: SectionList;
  viewport: Widget;
  highlighterManager: HighlighterManager;
  columnManager: ColumnManager;
  columnPosition: ColumnPosition;
  rowManager: RowManager;
  cellSelectionManager: CellSelectionManager;
  cellManager: CellManager;
  eventManager: EventManager;
  cellFocusManager: CellFocusManager;
  cellTooltipManager: CellTooltipManager;
  canvasGC: GraphicsContext;
  focused: boolean;
  wrapperId: string;

  cellHovered = new Signal<this, ICellData|null>(this);
  commSignal = new Signal<this, {}>(this);

  static FOCUS_CSS_CLASS = 'bko-focused';

  constructor(options: DataGrid.IOptions, dataStore: BeakerxDataStore) {
    super(options);

    //this is hack to use private DataGrid properties
    this.viewport = this['_viewport'];
    this.columnHeaderSections = this['_columnHeaderSections'];
    this.rowHeaderSections = this['_rowHeaderSections'];
    this.rowSections = this['_rowSections'];
    this.columnSections = this['_columnSections'];
    this.canvasGC = this['_canvasGC'];

    this.baseRowSize = DEFAULT_ROW_HEIGHT;
    this.baseColumnHeaderSize = DEFAULT_ROW_HEIGHT;

    this.setSectionWidth = this.setSectionWidth.bind(this);
    this.updateColumnWidth = this.updateColumnWidth.bind(this);
    this.setInitialSectionWidth = this.setInitialSectionWidth.bind(this);
    this.resizeSectionWidth = this.resizeSectionWidth.bind(this);
    this.resize = throttle(this.resize, 150, this);
    this.init(dataStore);
  }

  init(store: BeakerxDataStore) {
    this.id = 'grid_' + bkUtils.generateId(6);
    this.store = store;
    this.columnManager = new ColumnManager(this);
    this.columnPosition = new ColumnPosition(this);
    this.rowManager = new RowManager(selectValues(store.state), selectHasIndex(store.state), this.columnManager);
    this.cellSelectionManager = new CellSelectionManager(this);
    this.cellManager = new CellManager(this);
    this.eventManager = new EventManager(this);
    this.cellFocusManager = new CellFocusManager(this);
    this.cellTooltipManager = new CellTooltipManager(this, selectTooltips(store.state));
    this.model = new BeakerxDataGridModel(store, this.columnManager, this.rowManager);
    this.focused = false;

    this.columnManager.addColumns();
    this.rowManager.createFilterExpressionVars();
    this.store.changed.connect(throttle<void, void>(this.handleStateChanged, 100, this));

    this.installMessageHook();
    this.addHighlighterManager();
    this.addCellRenderers();
    this.setInitialSize();
  }

  setInitialSize() {
    this.resizeHeader();
    this.updateWidgetHeight();
    this.setInitialSectionWidths();
    this.updateWidgetWidth();
  }

  getColumn(config: CellRenderer.ICellConfig): DataGridColumn {
    return this.columnManager.getColumn(config);
  }

  getColumnByName(columnName: string): DataGridColumn|undefined {
    return this.columnManager.getColumnByName(columnName);
  }

  getCellData(clientX: number, clientY: number): ICellData|null {
    return DataGridCell.getCellData(this, clientX, clientY);
  }

  getColumnOffset(position: number, region: ColumnRegion): number {
    if (region === 'row-header') {
      return this.rowHeaderSections.sectionOffset(position);
    }

    return this.rowHeaderSections.totalSize + this.columnSections.sectionOffset(position);
  }

  getRowOffset(row: number) {
    return this.rowSections.sectionOffset(row);
  }

  isOverHeader(event: MouseEvent) {
    let rect = this.viewport.node.getBoundingClientRect();
    let x = event.clientX - rect.left;
    let y = event.clientY - rect.top;

    return x < (this.bodyWidth + this.rowHeaderSections.totalSize) && y < this.headerHeight;
  }

  updateModelData(state: IDataModelState) {
    this.model.updateData(state);
    this.columnManager.recalculateMinMaxValues();
    this.setInitialSize();
  }

  setWrapperId(id: string) {
    this.wrapperId = id;
  }

  resize(args?: any): void {
    this.updateWidgetHeight();
    this.resizeHeader();
    this.resizeSections();
    this.updateWidgetWidth();
    this.columnManager.updateColumnFilterNodes();
    this.columnManager.updateColumnMenuTriggers();
  }

  updateWidgetHeight() {
    this.node.style.minHeight = `${this.getWidgetHeight()}px`;
  }

  updateWidgetWidth() {
    const spacing = 2 * (DEFAULT_GRID_PADDING + DEFAULT_GRID_BORDER_WIDTH) + 1;
    const hasVScroll = (
      this.rowManager.rowsToShow !== -1 && this.rowManager.rowsToShow <= this.model.rowCount('body')
    );
    const vScrollWidth = hasVScroll ? this['_vScrollBarMinWidth'] + 1 : 0;
    const width = this.totalWidth + spacing + vScrollWidth;

    this.node.style.width = `${width}px`;
    this.fit();
  }

  setInitialSectionWidths() {
    for (let index = this.columnSections.sectionCount - 1; index >= 0; index--) {
      this.setInitialSectionWidth({ index }, 'body', COLUMN_TYPES.body);
    }

    for (let index = this.rowHeaderSections.sectionCount - 1; index >= 0; index--) {
      this.setInitialSectionWidth({ index }, 'row-header', COLUMN_TYPES.index);
    }
  }

  setInitialSectionWidth(section, region: DataModel.ColumnRegion, columnType: COLUMN_TYPES) {
    const column = this.columnPosition.getColumnByPosition({ region, value: section.index });
    const area = region === 'row-header' ? 'row-header' : 'column';

    this.setSectionWidth(area, column, this.getSectionWidth(column));
  }

  setFocus(focus: boolean) {
    this.focused = focus;

    if (focus) {
      disableKeyboardManager();
      this.node.classList.add(BeakerxDataGrid.FOCUS_CSS_CLASS);
      this.node.focus();

      return;
    }

    this.cellHovered.emit(null);
    this.cellTooltipManager.hideTooltip();
    this.node.classList.remove(BeakerxDataGrid.FOCUS_CSS_CLASS);
    enableKeyboardManager();
  }

  colorizeColumnBorder(column: number, color: string, region: CellRegion) {
    let sectionList = region === 'corner-header' ? this.rowHeaderSections : this.columnSections;
    let sectionSize = sectionList.sectionSize(column);
    let sectionOffset = sectionList.sectionOffset(column);
    let x = sectionOffset + sectionSize;
    let height = this.totalHeight;

    if (region !== 'corner-header') {
      x = x + this.rowHeaderSections.totalSize - this.scrollX;
    }

    this.canvasGC.beginPath();
    this.canvasGC.lineWidth = 1;

    this.canvasGC.moveTo(x - 0.5, 0);
    this.canvasGC.lineTo(x - 0.5, height);
    this.canvasGC.strokeStyle = color;
    this.canvasGC.stroke();
  }

  handleEvent(event: Event): void {
    this.eventManager.handleEvent(event, super.handleEvent);
  }

  messageHook(handler: IMessageHandler, msg: Message): boolean {
    super.messageHook(handler, msg);

    if (handler === this.viewport && msg.type === 'section-resize-request') {
      this.columnSections['_sections'].forEach(this.updateColumnWidth('body'));
      this.rowHeaderSections['_sections'].forEach(this.updateColumnWidth('row-header'));
      this.updateWidgetWidth();
      this.updateWidgetHeight();
    }

    return true;
  }

  destroy() {
    this.eventManager.destroy();
    this.columnManager.destroy();

    Signal.disconnectAll(this);
  }

  onAfterAttach(msg) {
    super.onAfterAttach(msg);

    this.columnManager.bodyColumns.forEach(column => column.columnFilter.attach(this.viewport.node));
    this.columnManager.indexColumns.forEach(column => column.columnFilter.attach(this.viewport.node));
  }

  private installMessageHook() {
    MessageLoop.installMessageHook(this.viewport, this.viewportResizeMessageHook.bind(this));
  }

  private addHighlighterManager() {
    let cellHighlighters: IHihglighterState[] = selectCellHighlighters(this.store.state);

    this.highlighterManager = new HighlighterManager(this, cellHighlighters);
  }

  private addCellRenderers() {
    let cellRendererFactory = new CellRendererFactory(this);
    let defaultRenderer = cellRendererFactory.getRenderer();

    this.cellRenderers.set('body', {}, defaultRenderer);
    this.cellRenderers.set('column-header', {}, defaultRenderer);
    this.cellRenderers.set('corner-header', {}, defaultRenderer);
    this.cellRenderers.set('row-header', {}, defaultRenderer);
  }

  private updateColumnWidth(region: ColumnRegion): Function {
    return ({ index, size }) => {
      let columnOnPosition = this.columnManager.getColumnByPosition({ region, value: index });

      columnOnPosition.setWidth(size);
    }
  }

  private handleStateChanged() {
    this.model.reset();
  }

  private getWidgetHeight() {
    const bodyRowCount = this.model.rowCount('body');
    const rowsToShow = this.rowManager.rowsToShow;
    const rowCount = rowsToShow < bodyRowCount && rowsToShow !== -1 ? rowsToShow : bodyRowCount;
    const hasHScroll = !this['_hScrollBar'].isHidden;
    const scrollBarHeight = hasHScroll ? this['_hScrollBarMinHeight'] : 0;
    const spacing = 2 * (DEFAULT_GRID_PADDING + DEFAULT_GRID_BORDER_WIDTH);

    return rowCount * this.baseRowSize + this.headerHeight + spacing + scrollBarHeight;
  }

  private resizeSections() {
    this.columnManager.bodyColumns.forEach(this.resizeSectionWidth);
    this.columnManager.indexColumns.forEach(this.resizeSectionWidth);
  }

  private resizeSectionWidth(column) {
    const position = column.getPosition();
    const value = selectColumnWidth(this.store.state, column);
    const area = position.region === 'row-header' ? 'row-header' : 'column';

    if (value === 0) {
      return this.setSectionWidth(area, column, this.getSectionWidth(column));
    }

    this.resizeSection(area, position.value, value);
  }

  private resizeHeader() {
    let bodyColumnNamesWidths: number[] = [];
    let indexColumnNamesWidths: number[] = [];

    if (selectHeadersVertical(this.store.state)) {
      const mapNameToWidth = name => getStringSize(name, selectHeaderFontSize(this.store.state)).width;

      bodyColumnNamesWidths = this.columnManager.bodyColumnNames.map(mapNameToWidth);
      indexColumnNamesWidths = this.columnManager.indexColumnNames.map(mapNameToWidth);
    }

    this.baseColumnHeaderSize = Math.max.apply(
      null,
      [...bodyColumnNamesWidths, ...indexColumnNamesWidths, DEFAULT_ROW_HEIGHT]
    );
  }

  private getSectionWidth(column) {
    const position = column.getPosition();
    const value = String(column.formatFn(this.cellManager.createCellConfig({
      region: position.region,
      value: column.longestStringValue || column.maxValue,
      column: position.value,
      row: 0,
    })));
    const nameSize = getStringSize(column.name, selectHeaderFontSize(this.store.state));
    const valueSize = getStringSize(value, selectDataFontSize(this.store.state));
    const nameSizeProp = selectHeadersVertical(this.store.state) ? 'height' : 'width';

    nameSize.width += 4; // Add space for the menu
    const result = nameSize[nameSizeProp] > valueSize.width - 7 ? nameSize[nameSizeProp] : valueSize.width;

    return result > MIN_COLUMN_WIDTH ? result : MIN_COLUMN_WIDTH;
  }

  private setSectionWidth(area, column: DataGridColumn, value: number) {
    this.resizeSection(area, column.getPosition().value, value);
    column.setWidth(value);
  }

  private viewportResizeMessageHook(handler, msg) {
    if (handler === this.viewport && msg.type === 'resize') {
      setTimeout(() => {
        this['_syncViewport']();
      });
    }

    return true;
  }
}
