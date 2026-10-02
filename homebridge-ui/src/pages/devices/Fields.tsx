import type { ReactNode } from 'react';
import { Select, Text } from '@radix-ui/themes';

export function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return <div className="device-field">
    <Text as="label" htmlFor={id} size="2" weight="medium">{label}</Text>
    {children}
    {help && <Text as="p" id={`${id}-help`} className="device-field-help" size="1" color="gray">{help}</Text>}
  </div>;
}

export function Choice({ id, value, options, onChange, disabled, control }: {
  id: string; value: string; options: Array<[string, string]>; onChange(value: string): void; disabled?: boolean; control: string;
}) {
  return <Select.Root value={value || '__none'} onValueChange={(next) => onChange(next === '__none' ? '' : next)} disabled={disabled ?? false} size="3">
    <Select.Trigger id={id} data-device-control={control} />
    <Select.Content position="popper">
      {options.map(([key, label]) => <Select.Item key={key || '__none'} value={key || '__none'}>{label}</Select.Item>)}
    </Select.Content>
  </Select.Root>;
}
