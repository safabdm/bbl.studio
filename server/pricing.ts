import { PACKAGE_PRESETS, type PaymentOption } from './packages';
export type { PaymentOption };

export type InstallmentInput = {
  name: string;
  amount_cents: number;
  percent?: number | null;
  due_at?: string | null;
  milestone: string;
  status?: string;
};

export type PricingInput = {
  package_id: string | null;
  package_name: string;
  base_price_cents: number;
  discount_cents: number;
  additional_services_cents: number;
  third_party_cents: number;
  tax_cents: number;
  currency: string;
  proposal_expires_at: string | null;
  deposit_required_cents: number;
  deposit_percent: number | null;
  deposit_mode: 'percent' | 'amount';
  payment_option: PaymentOption;
  installments: InstallmentInput[];
  client_pricing_notes: string;
  internal_notes: string;
  additional_services: { label: string; amount_cents: number }[];
  third_party_expenses: { label: string; amount_cents: number }[];
  deliverables: string[];
};

export function computeTotal(input: Pick<PricingInput, 'base_price_cents' | 'discount_cents' | 'additional_services_cents' | 'third_party_cents' | 'tax_cents'>) {
  return Math.max(
    0,
    input.base_price_cents
      - input.discount_cents
      + input.additional_services_cents
      + input.third_party_cents
      + input.tax_cents,
  );
}

export function roundCents(value: number) {
  return Math.max(0, Math.round(value));
}

export function buildPlan(option: PaymentOption, total: number, input: PricingInput): { ok: true; installments: InstallmentInput[] } | { ok: false; message: string } {
  if (total <= 0) return { ok: false, message: 'Final contract total must be greater than $0 before publishing.' };

  if (option === 'full') {
    return {
      ok: true,
      installments: [{
        name: 'Full payment',
        amount_cents: total,
        percent: 100,
        due_at: input.proposal_expires_at,
        milestone: '100% payment before work begins',
        status: 'due',
      }],
    };
  }

  if (option === 'two') {
    let deposit = input.deposit_mode === 'amount'
      ? roundCents(input.deposit_required_cents)
      : roundCents(total * ((input.deposit_percent ?? 50) / 100));
    if (deposit <= 0 || deposit >= total) {
      return { ok: false, message: 'Two-payment plans need a deposit that is greater than $0 and less than the contract total.' };
    }
    const remaining = total - deposit;
    return {
      ok: true,
      installments: [
        { name: 'Deposit', amount_cents: deposit, percent: Math.round((deposit / total) * 10000) / 100, due_at: null, milestone: 'Deposit before work begins', status: 'due' },
        { name: 'Remaining balance', amount_cents: remaining, percent: Math.round((remaining / total) * 10000) / 100, due_at: null, milestone: 'Remaining balance before final release', status: 'due' },
      ],
    };
  }

  if (option === 'three') {
    const first = roundCents(total * 0.5);
    const second = roundCents(total * 0.25);
    const third = total - first - second;
    return {
      ok: true,
      installments: [
        { name: 'Deposit', amount_cents: first, percent: 50, due_at: null, milestone: '50% deposit before work begins', status: 'due' },
        { name: 'First preview', amount_cents: second, percent: 25, due_at: null, milestone: '25% at first preview', status: 'due' },
        { name: 'Final release', amount_cents: third, percent: Math.round((third / total) * 10000) / 100, due_at: null, milestone: '25% before final release', status: 'due' },
      ],
    };
  }

  const custom = input.installments.map((item, index) => ({
    name: item.name?.trim() || `Installment ${index + 1}`,
    amount_cents: roundCents(item.amount_cents),
    percent: item.percent ?? (total ? Math.round((item.amount_cents / total) * 10000) / 100 : 0),
    due_at: item.due_at || null,
    milestone: item.milestone?.trim() || item.name?.trim() || `Milestone ${index + 1}`,
    status: item.status || 'due',
  }));
  if (!custom.length) return { ok: false, message: 'Custom payment plans need at least one installment.' };
  const sum = custom.reduce((acc, item) => acc + item.amount_cents, 0);
  if (sum !== total) {
    return {
      ok: false,
      message: `Installments total ${formatMoney(sum, input.currency)} but the contract total is ${formatMoney(total, input.currency)}. They must match exactly.`,
    };
  }
  return { ok: true, installments: custom };
}

export function formatMoney(cents: number, currency = 'USD') {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency });
}

export function defaultPricingFromPreset(packageId: string): PricingInput {
  const preset = PACKAGE_PRESETS.find((item) => item.id === packageId) || PACKAGE_PRESETS.find((item) => item.id === 'pkg_custom') || PACKAGE_PRESETS[0];
  const twoDefault = roundCents(preset.starting_price_cents * 0.5);
  return {
    package_id: preset.id,
    package_name: preset.name,
    base_price_cents: preset.starting_price_cents,
    discount_cents: 0,
    additional_services_cents: 0,
    third_party_cents: 0,
    tax_cents: 0,
    currency: 'USD',
    proposal_expires_at: new Date(Date.now() + 21 * 86400000).toISOString(),
    deposit_required_cents: twoDefault,
    deposit_percent: 50,
    deposit_mode: 'percent',
    payment_option: 'two',
    installments: [],
    client_pricing_notes: preset.monthly
      ? `Monthly support is billed in USD at ${preset.price_label}. Unused updates do not roll over unless agreed in writing.`
      : '',
    internal_notes: '',
    additional_services: [],
    third_party_expenses: [],
    deliverables: [...preset.deliverables],
  };
}

export { PACKAGE_PRESETS };
