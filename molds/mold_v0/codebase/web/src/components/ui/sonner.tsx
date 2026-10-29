'use client';

import { useColorMode } from '@/components/themes/theme-provider';
import { Toaster as Sonner, ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved: theme } = useColorMode();

  return (
    <Sonner
      theme={theme}
      className='toaster group'
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)'
        } as React.CSSProperties
      }
      position='top-center'
      {...props}
    />
  );
};

export { Toaster };
