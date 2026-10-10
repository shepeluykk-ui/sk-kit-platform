import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { KsDocument } from '../types';
import {
  CircleDollarSign,
  FileSpreadsheet,
  CheckCircle2,
  Clock,
  Download,
  FileCheck,
  AlertTriangle,
  ArrowRight
} from 'lucide-react';

export const FinanceView: React.FC = () => {
  const { ksDocuments, ksDocumentsStatus, ksDocumentsError, retryFetchKsDocuments, financialSummary, approveKsDoc, activeProject, can, currentUser } = useApp();
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const handleApprove = async (ksId: string) => {
    setApproveError(null);
    setApprovingId(ksId);
    const result = await approveKsDoc(ksId);
    setApprovingId(null);
    if (!result.success) {
      setApproveError(result.error || 'Не удалось согласовать документ');
    }
  };

  if (ksDocumentsStatus === 'loading' || ksDocumentsStatus === 'idle') {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-neutral-500">
        <div className="h-5 w-5 mr-3 rounded-full border-2 border-neutral-300 border-t-cyan-600 animate-spin" />
        Загрузка финансовых данных с сервера…
      </div>
    );
  }

  if (ksDocumentsStatus === 'error') {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <div className="text-sm font-semibold text-neutral-900">Не удалось загрузить финансовые данные</div>
        <div className="text-xs text-neutral-500 max-w-md">{ksDocumentsError}</div>
        <button
          onClick={retryFetchKsDocuments}
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
            ФИНАНСОВЫЙ КОНТРОЛЬ И АКТИРОВАНИЕ (КС-2 / КС-3)
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Сопоставление: Договор ↔ Смета ↔ Фактически выполнено ↔ Принято по ИД ↔ Оплачено.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => alert('Экспорт реестра КС-2 в формате Excel (ГРАНД-Смета совместимый)')}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-800 hover:bg-neutral-50 shadow-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Выгрузить КС-2 / КС-3
          </button>
        </div>
      </div>

      {/* 5 Financial Stages Progress */}
      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-xs space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700">
          Сквозной баланс финансирования объекта (по данным договоров и актов)
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <div className="p-3.5 rounded-xl bg-neutral-50 border border-neutral-100">
            <span className="text-[10px] font-bold text-neutral-400 uppercase">1. Договорной бюджет</span>
            <div className="text-lg font-bold text-neutral-900 mt-1">
              {(((financialSummary?.budgetContractRub ?? 0)) / 1000000).toFixed(2)} млн ₽
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5">Лимит финансирования</div>
          </div>

          <div className="p-3.5 rounded-xl bg-neutral-50 border border-neutral-100">
            <span className="text-[10px] font-bold text-neutral-400 uppercase">2. Факт СМР</span>
            <div className="text-lg font-bold text-neutral-900 mt-1">
              {(((financialSummary?.executedRub ?? 0)) / 1000000).toFixed(2)} млн ₽
            </div>
            <div className="text-[11px] text-blue-600 font-semibold mt-0.5">
              {financialSummary?.budgetContractRub ? (((financialSummary.executedRub ?? 0) / financialSummary.budgetContractRub) * 100).toFixed(1) : '0.0'}% от договора
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-neutral-50 border border-neutral-100">
            <span className="text-[10px] font-bold text-neutral-400 uppercase">3. Принято технадзором</span>
            <div className="text-lg font-bold text-emerald-700 mt-1">
              {(((financialSummary?.acceptedRub ?? 0)) / 1000000).toFixed(2)} млн ₽
            </div>
            <div className="text-[11px] text-emerald-600 font-semibold mt-0.5">
              Подтверждено АОСР (100% ИД)
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-neutral-50 border border-neutral-100">
            <span className="text-[10px] font-bold text-neutral-400 uppercase">4. Оплачено Заказчиком</span>
            <div className="text-lg font-bold text-neutral-900 mt-1">
              {(((financialSummary?.paidRub ?? 0)) / 1000000).toFixed(2)} млн ₽
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5">По платежным поручениям</div>
          </div>
        </div>
      </div>

      {/* KS-2 / KS-3 Documents Registry */}
      <div className="rounded-xl border border-neutral-200 bg-white shadow-xs overflow-hidden">
        <div className="p-4 border-b border-neutral-100 bg-neutral-50/50 flex items-center justify-between">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-700">
            Реестр актов о приемке выполненных работ (Форма КС-2) и справок (КС-3)
          </div>
          <span className="text-[11px] text-neutral-500">Автоматическая сверка с объемами АОСР</span>
        </div>

        {approveError && (
          <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{approveError}</span>
            <button onClick={() => setApproveError(null)} className="ml-auto text-red-600 hover:text-red-800 cursor-pointer">✕</button>
          </div>
        )}
        {ksDocumentsStatus === 'empty' && (
          <div className="px-4 py-3 text-xs text-neutral-600 border-b border-neutral-100">
            На сервере пока нет документов КС-2/КС-3 для этого проекта.
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-neutral-100/70 text-neutral-600 uppercase font-semibold text-[10px] tracking-wider border-b border-neutral-200">
              <tr>
                <th className="py-3 px-3">Номер акта</th>
                <th className="py-3 px-4">Отчетный период</th>
                <th className="py-3 px-3">Подрядчик</th>
                <th className="py-3 px-3 text-right">Сумма акта, ₽</th>
                <th className="py-3 px-3 text-center">Статус согласования</th>
                <th className="py-3 px-3 text-center">Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 text-neutral-800">
              {ksDocuments.map(ks => {
                return (
                  <tr key={ks.id} className="hover:bg-neutral-50 transition-colors">
                    <td className="py-3 px-3 font-mono font-bold text-neutral-900">{ks.docNumber}</td>
                    <td className="py-3 px-4 font-semibold">{ks.periodStart} — {ks.periodEnd}</td>
                    <td className="py-3 px-3 text-neutral-700">{ks.contractorOrgName}</td>
                    <td className="py-3 px-3 text-right font-mono font-bold text-neutral-900">
                      {ks.totalSumWithVatRub.toLocaleString('ru-RU')} ₽
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span
                        className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase font-mono ${
                          ks.status === 'SIGNED_CUSTOMER' || ks.status === 'PAID'
                            ? 'bg-emerald-600 text-white'
                            : ks.status === 'APPROVED_SUPERVISOR'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {ks.status}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-center">
                      {ks.status === 'SIGNED_CUSTOMER' || ks.status === 'PAID' ? (
                        <span className="text-[11px] text-emerald-700 font-bold">Утвержден</span>
                      ) : can('APPROVE', 'finance') ? (
                        <button
                          onClick={() => handleApprove(ks.id)}
                          disabled={approvingId === ks.id}
                          className="text-xs font-bold text-neutral-900 border border-neutral-300 rounded px-2.5 py-1 hover:bg-neutral-100 shadow-xs disabled:opacity-50 cursor-pointer"
                        >
                          {approvingId === ks.id ? 'Согласование…' : 'Согласовать КС'}
                        </button>
                      ) : (
                        <span className="text-[11px] text-neutral-400">Ожидает согласования</span>
                      )}
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
