import { Badge as RadixBadge, Button as RadixButton } from '@radix-ui/themes';
import type { ComponentPropsWithRef, ForwardRefExoticComponent } from 'react';

/**
 * Themes 3.3 emits highContrast.default: undefined, which its BooleanPropDef
 * rejects under exactOptionalPropertyTypes and consequently infers as never.
 * Keep the real components and strict application types; repair only that prop.
 */
type ContrastProps<T> = Omit<T, 'highContrast'> & { highContrast?: boolean };
export const Button = RadixButton as ForwardRefExoticComponent<ContrastProps<ComponentPropsWithRef<typeof RadixButton>>>;
export const Badge = RadixBadge as ForwardRefExoticComponent<ContrastProps<ComponentPropsWithRef<typeof RadixBadge>>>;
