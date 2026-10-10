import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { ScheduleTask, TaskProgressStatus } from '../types';
import {
  Calendar,
  Clock,
  AlertOctagon,
  CheckCircle2,
  TrendingDown,
  TrendingUp,
  Filter,
  Layers,
  ShieldAlert,
  ChevronRight,
  AlertTriangle
} from 'lucide-react';

export const ScheduleView: React.FC = () => {
  const { scheduleTasks, scheduleTasksStatus, scheduleTasksError, retryFetchScheduleTasks, activeProject } = useApp();
  const [criticalOnly, setCriticalOnly] = useState(false);

  const filteredTasks = scheduleTasks.filter(t => (criticalOnly ? t.isCriticalPath : true));

  if (scheduleTasksStatus === 'loading' || scheduleTasksStatus === 'idle') {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-neutral-500">
        <div className="h-5 w-5 mr-3 rounded-full border-2 border-neutral-300 border-t-cyan-600 animate-spin" />
        Загрузка графика работ с сервера…
      </div>
    );
  }

  if (scheduleTasksStatus === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <div className="text-sm font-semibold text-neutral-900">Не удалось загрузить график работ</div>
        <div className="text-xs text-neutral-500 max-w-md">{scheduleTasksError}</div>
        <button
          onClick={retryFetchScheduleTasks}
          className="mt-2 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold cursor-pointer"
        >
          Повторить попытку
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-200 pb-4">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 tracking-tight">
            КАЛЕНДАРНЫЙ ГРАФИК & WBS СТРУКТУРА (ДИАГРАММА ГАНТА)
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Контроль критического пути, индекса выполнения сроков (SPI) и блокировок Hold Points.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setCriticalOnly(!criticalOnly)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              criticalOnly
                ? 'bg-red-600 text-white border-red-700 shadow-xs'
                : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
            }`}
          >
            {criticalOnly ? 'Показан только Критический Путь' : 'Показать Критический Путь'}
          </button>
        </div>
      </div>

      {scheduleTasksStatus === 'empty' && (
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3.5 py-2 text-xs text-neutral-600">
          На сервере пока нет задач графика для этого проекта.
        </div>
      )}

      {/* KPI Top Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-xs">
          <div className="text-xs font-semibold uppercase text-neutral-500">Сроки реализации</div>
          <div className="mt-1 text-sm font-bold text-neutral-900">
            {activeProject.startDate} — {activeProject.plannedFinishDate}
          </div>
          <div className="text-[11px] text-amber-700 font-semibold mt-1">
            Прогноз завершения: {activeProject.forecastFinishDate} (+14 дн.)
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-xs">
          <div className="text-xs font-semibold uppercase text-neutral-500">Средний SPI (Сроки)</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-amber-700">0.91</span>
            <span className="text-xs text-neutral-500">SPI &lt; 1.0 = Отставание</span>
          </div>
          <div className="text-[11px] text-neutral-400 mt-1">Задержка на критических участках</div>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-xs">
          <div className="text-xs font-semibold uppercase text-neutral-500">Статус Hold Points</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-xs font-bold text-red-800 bg-red-100 px-2 py-0.5 rounded">
              1 РАБОТА ЗАБЛОКИРОВАНА
            </span>
          </div>
          <div className="text-[11px] text-neutral-500 mt-1">
            Зашивка шахт остановлена до сдачи опрессовки
          </div>
        </div>
      </div>

      {/* Interactive Gantt / Timeline Grid Table */}
      <div className="rounded-xl border border-neutral-200 bg-white shadow-xs overflow-hidden">
        <div className="p-4 border-b border-neutral-100 flex items-center justify-between bg-neutral-50/50">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-700">
            Иерархическая структура работ (WBS) и календарная шкала
          </div>
          <div className="text-[11px] text-neutral-500 font-medium">
            Июль 2024 — Октябрь 2024
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-100/70 text-neutral-600 uppercase font-semibold text-[10px] tracking-wider border-b border-neutral-200">
              <tr>
                <th className="py-3 px-3">WBS</th>
                <th className="py-3 px-4 min-w-[240px]">Наименование пакета работ</th>
                <th className="py-3 px-3">Подрядчик</th>
                <th className="py-3 px-3">Даты</th>
                <th className="py-3 px-2 text-center">Дней</th>
                <th className="py-3 px-3 text-center">SPI</th>
                <th className="py-3 px-3 text-center">Прогресс</th>
                <th className="py-3 px-4 min-w-[200px]">График Ганта (Таймлайн)</th>
                <th className="py-3 px-3 text-center">Статус</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-neutral-800">
              {filteredTasks.map(task => {
                const isBlocked = task.status === 'HOLD_POINT_BLOCKED';

                return (
                  <tr
                    key={task.id}
                    className={`hover:bg-neutral-50 transition-colors ${
                      isBlocked ? 'bg-red-50/30' : ''
                    }`}
                  >
                    <td className="py-3 px-3 font-mono font-bold text-neutral-500">{task.wbsCode}</td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-neutral-900 flex items-center gap-1.5">
                        {task.isCriticalPath && (
                          <span className="text-[9px] font-bold bg-red-600 text-white px-1.5 py-0.2 rounded font-mono">
                            КРИТ
                          </span>
                        )}
                        {task.title}
                      </div>
                      <div className="text-[11px] text-neutral-500 mt-0.5">
                        Раздел: {task.section} • Объем: {task.actualVolume} / {task.plannedVolume} {task.unit}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-neutral-700">{task.assignedContractorName}</td>
                    <td className="py-3 px-3 font-mono text-[11px] text-neutral-600">
                      {task.startDate} — {task.finishDate}
                    </td>
                    <td className="py-3 px-2 text-center font-mono">{task.durationDays}</td>
                    <td className="py-3 px-3 text-center font-mono font-bold">
                      <span className={task.spi < 1.0 ? 'text-amber-700' : 'text-emerald-700'}>
                        {task.spi}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-center font-bold font-mono">
                      {task.progressPercent}%
                    </td>

                    {/* Visual Gantt Bar */}
                    <td className="py-3 px-4">
                      <div className="h-4 w-full rounded bg-neutral-100 relative overflow-hidden">
                        <div
                          className={`h-full rounded transition-all ${
                            isBlocked
                              ? 'bg-red-500'
                              : task.progressPercent === 100
                              ? 'bg-emerald-600'
                              : 'bg-neutral-900'
                          }`}
                          style={{ width: `${task.progressPercent}%` }}
                        />
                      </div>
                    </td>

                    <td className="py-3 px-3 text-center">
                      <span
                        className={`text-[9px] font-bold px-2 py-0.5 rounded font-mono uppercase ${
                          isBlocked
                            ? 'bg-red-600 text-white'
                            : task.status === 'COMPLETED'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {isBlocked ? 'HOLD POINT BLOCK' : task.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
