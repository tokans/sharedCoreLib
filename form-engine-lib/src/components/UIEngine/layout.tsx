/**
 * UIEngine Layout System
 * Handles component positioning at different LayoutDirections
 */

import React, { useMemo } from 'react';
import { LayoutDirection, SubComponentPlacement } from './types';
import { useUIEngine, useConditionEvaluator, useTheme, useBreakpoint } from './context';
import { ComponentRenderer } from './renderers';

// ─────────────────────────────────────────────────────────────────────────────
// PORTRAIT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the viewport is narrower than 768 px OR taller than it is
 * wide (portrait orientation). Updates reactively on resize / orientation change.
 */
function useIsPortrait(): boolean {
  const [portrait, setPortrait] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 768 || window.innerHeight > window.innerWidth;
  });

  React.useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px), (orientation: portrait)');
    const handler = (e: MediaQueryListEvent) => setPortrait(e.matches);
    mql.addEventListener('change', handler);
    setPortrait(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return portrait;
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT CONTAINER
// ─────────────────────────────────────────────────────────────────────────────

export interface LayoutProps {
  children: React.ReactNode;
  direction: LayoutDirection;
  /** Flex-weight for Left / Right panels in landscape (default 1). */
  span?: number;
  /** When true the panel sits in a vertical stack — span is ignored. */
  isPortrait?: boolean;
}

export const LayoutContainer: React.FC<LayoutProps> = ({ children, direction, span = 1, isPortrait = false }) => {
  const theme = useTheme();
  const breakpoint = useBreakpoint();

  const getDirectionStyles = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      display: 'flex',
    };

    switch (direction) {
      case LayoutDirection.Center:
        return {
          ...baseStyle,
          flexDirection: 'column',
          flex: 1,
          justifyContent: 'flex-start',
          alignItems: 'stretch',
          minHeight: '400px',
          padding: `0 ${theme.spacing?.md || '16px'}`,
        };

      case LayoutDirection.Top:
        return {
          ...baseStyle,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: theme.spacing?.md || '16px',
          backgroundColor: theme.colors?.primary || '#007AFF',
          color: 'white',
          minHeight: '56px',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          boxShadow: theme.elevation?.default || '0 2px 4px rgba(0,0,0,0.1)',
        };

      case LayoutDirection.Bottom:
        return {
          ...baseStyle,
          flexDirection: 'row',
          justifyContent: 'space-around',
          alignItems: 'center',
          padding: theme.spacing?.md || '16px',
          backgroundColor: theme.colors?.surface || '#FFFFFF',
          borderTop: `1px solid ${theme.colors?.outline || '#E0E0E0'}`,
          minHeight: '56px',
          position: 'sticky',
          bottom: 0,
          zIndex: 100,
        };

      case LayoutDirection.Left:
        return isPortrait
          ? {
              ...baseStyle,
              flexDirection: 'column',
              justifyContent: 'flex-start',
              alignItems: 'stretch',
              width: '100%',
              position: 'relative',
              zIndex: 1,
              overflowY: 'auto',
            }
          : {
              ...baseStyle,
              flexDirection: 'column',
              justifyContent: 'flex-start',
              alignItems: 'stretch',
              flex: breakpoint?.columns ? (breakpoint.columns / 24) : span,
              minWidth: 0,
              position: 'relative',
              zIndex: 1,
              overflowY: 'auto',
            };

      case LayoutDirection.Right:
        return isPortrait
          ? {
              ...baseStyle,
              flexDirection: 'column',
              justifyContent: 'flex-start',
              alignItems: 'center',
              width: '100%',
              position: 'relative',
              zIndex: 1,
              overflowY: 'auto',
              padding: theme.spacing?.md || '16px',
            }
          : {
              ...baseStyle,
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              flex: breakpoint?.columns ? ((24 - breakpoint.columns) / 24) * 2 : span,
              minWidth: 0,
              position: 'relative',
              zIndex: 1,
              overflowY: 'auto',
              padding: theme.spacing?.lg || '32px',
            };

      case LayoutDirection.Floating:
        return {
          ...baseStyle,
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 0,
          overflow: 'hidden',
        };

      case LayoutDirection.Modal:
        return {
          ...baseStyle,
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 200,
          backdropFilter: 'blur(4px)',
        };

      default:
        return baseStyle;
    }
  };

  return <div style={getDirectionStyles()}>{children}</div>;
};

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT PLACEMENT RENDERER
// ─────────────────────────────────────────────────────────────────────────────

interface SubComponentRendererProps {
  placement: SubComponentPlacement;
}

export const SubComponentPlacementRenderer: React.FC<SubComponentRendererProps> = ({
  placement,
}) => {
  const { manifest } = useUIEngine();
  const evaluateCondition = useConditionEvaluator();
  const currentBreakpoint = useBreakpoint();

  // Check if placement should be shown at current breakpoint
  if (placement.breakpoint && currentBreakpoint?.label !== placement.breakpoint) {
    return null;
  }

  // Check if placement is hidden by condition
  if (placement.hidden_condition && !evaluateCondition(placement.hidden_condition)) {
    return null;
  }

  const component = manifest.components && manifest.components[placement.component_ref];
  if (!component) {
    console.warn(`Component not found: ${placement.component_ref}`);
    return null;
  }

  return (
    <ComponentRenderer
      component={component}
      componentId={placement.component_ref}
    />
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// DIRECTION-BASED LAYOUT GROUPER
// ─────────────────────────────────────────────────────────────────────────────

interface DirectionGroupProps {
  direction: LayoutDirection;
  placements: SubComponentPlacement[];
  isPortrait?: boolean;
}

const DirectionGroup: React.FC<DirectionGroupProps> = ({ direction, placements, isPortrait = false }) => {
  const filteredPlacements = useMemo(
    () => placements.filter(p => p.direction === direction),
    [placements, direction]
  );

  if (filteredPlacements.length === 0) {
    return null;
  }

  // Use the span declared on the first placement for this direction slot.
  // Typically Left and Right each have one placement; this covers that case cleanly.
  const span = filteredPlacements[0]?.span ?? 1;

  return (
    <LayoutContainer direction={direction} span={span} isPortrait={isPortrait}>
      {filteredPlacements.map((placement, index) => (
        <SubComponentPlacementRenderer
          key={`${placement.component_ref}-${placement.direction}-${index}`}
          placement={placement}
        />
      ))}
    </LayoutContainer>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN LAYOUT RENDERER
// ─────────────────────────────────────────────────────────────────────────────

interface ScreenLayoutProps {
  componentPlacements: SubComponentPlacement[];
}

export const ScreenLayout: React.FC<ScreenLayoutProps> = ({ componentPlacements }) => {
  const theme = useTheme();
  const isPortrait = useIsPortrait();

  const screenStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    backgroundColor: theme.colors?.surface || 'transparent',
    fontFamily: theme.typography?.font_family_default || 'system-ui, sans-serif',
    color: theme.colors?.on_surface || '#000',
    position: 'relative',
  };

  const hasCenter = useMemo(
    () => componentPlacements.some(p => p.direction === LayoutDirection.Center),
    [componentPlacements]
  );

  return (
    <div style={screenStyle}>
      {/* Full-screen floating overlays rendered at root level (background grids, orbs, etc.) */}
      <DirectionGroup direction={LayoutDirection.Floating} placements={componentPlacements} isPortrait={isPortrait} />

      {/* Modal overlays */}
      <DirectionGroup direction={LayoutDirection.Modal} placements={componentPlacements} isPortrait={isPortrait} />

      {/* Top bar / header */}
      <DirectionGroup direction={LayoutDirection.Top} placements={componentPlacements} isPortrait={isPortrait} />

      {/* Main content area — row on landscape, column on portrait */}
      <div style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        zIndex: 1,
        flexDirection: isPortrait ? 'column' : 'row',
      }}>
        {/* Left panel */}
        <DirectionGroup direction={LayoutDirection.Left} placements={componentPlacements} isPortrait={isPortrait} />

        {/* Center content — only rendered when center placements exist */}
        {hasCenter && (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
            <DirectionGroup direction={LayoutDirection.Center} placements={componentPlacements} isPortrait={isPortrait} />
          </div>
        )}

        {/* Right panel */}
        <DirectionGroup direction={LayoutDirection.Right} placements={componentPlacements} isPortrait={isPortrait} />
      </div>

      {/* Bottom bar / footer */}
      <DirectionGroup direction={LayoutDirection.Bottom} placements={componentPlacements} isPortrait={isPortrait} />
    </div>
  );
};

ScreenLayout.displayName = 'ScreenLayout';

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSIVE LAYOUT HANDLER
// ─────────────────────────────────────────────────────────────────────────────

interface ResponsiveLayoutProps {
  componentPlacements: SubComponentPlacement[];
}

export const ResponsiveLayout: React.FC<ResponsiveLayoutProps> = ({ componentPlacements }) => {
  const { dispatch } = useUIEngine();
  const breakpoint = useBreakpoint();

  // Handle responsive breakpoint changes
  React.useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      // Dispatch breakpoint update based on width
      // This would be expanded to check actual breakpoints
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [dispatch]);

  return <ScreenLayout componentPlacements={componentPlacements} />;
};