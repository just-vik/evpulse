'use client';

import React from 'react';
import { motion } from 'framer-motion';

interface PageProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
}

export const Page = React.memo(function Page({
  children,
  title,
  subtitle,
  action,
}: PageProps) {

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-6 max-w-[1600px]"
    >
      {/* Header */}

      {title && (
        <header className="flex items-start justify-between gap-4">

          <div>

            <h1 className="text-2xl lg:text-3xl font-bold text-foreground">
              {title}
            </h1>

            {subtitle && (
              <p className="text-muted-foreground mt-1">
                {subtitle}
              </p>
            )}

          </div>

          {action && (
            <div className="flex-shrink-0">
              {action}
            </div>
          )}

        </header>
      )}

      {/* Page content */}

      <section>
        {children}
      </section>

    </motion.div>
  );
});