import { css } from '@emotion/react';
import { useEffect, type FC, type KeyboardEvent } from 'react';
import { useGraphHistoryNavigation } from '../../../../rivet/packages/app/src/hooks/useGraphHistoryNavigation';
import LeftIcon from 'majesticons/line/chevron-left-line.svg?react';
import RightIcon from 'majesticons/line/chevron-right-line.svg?react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import { useAtom, useAtomValue } from 'jotai';
import { goToSearchState, searchingGraphState } from '../../../../rivet/packages/app/src/state/graphBuilder';
import { Tooltip } from '../../../../rivet/packages/app/src/components/Tooltip';
import {
  useSearchProject,
  type SearchedItem,
} from '../../../../rivet/packages/app/src/hooks/useSearchProject';
import { projectState } from '../../../../rivet/packages/app/src/state/savedGraphs';
import clsx from 'clsx';
import { useGoToNode } from '../../../../rivet/packages/app/src/hooks/useGoToNode';
import { type NodeId } from '@ironclad/rivet-core';

const styles = css`
  position: fixed;
  top: calc(50px + var(--project-selector-height));
  left: calc(var(--workflow-dashboard-sidebar-width, 0px) + 275px);
  background: transparent;
  z-index: 50;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;

  &.sidebar-closed {
    left: calc(var(--workflow-dashboard-sidebar-width, 0px) + 25px);
  }

  .button-placeholder {
    width: 32px;
    height: 32px;
  }

  button {
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    border-radius: 5px;
    background: transparent;
    padding: 8px;
    width: 32px;
    height: 32px;
    justify-content: center;
    box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);

    &:hover {
      background-color: rgba(255, 255, 255, 0.2);
    }

    svg {
      width: 16px;
      height: 16px;
    }
  }

  .search {
    position: relative;
    input {
      background: var(--grey-dark);
      border: none;
      border-radius: 4px;
      padding: 4px 8px;
      color: var(--grey-lightest);
      width: 200px;
      height: 32px;
      font-size: 14px;
      font-family: var(--font-family);
      font-weight: 500;
      box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
    }

    .stopSearching {
      position: absolute;
      right: 0;
      top: 0;
      display: flex;
      align-items: center;
      justify-content: center;

      width: 32px;
      height: 32px;

      svg {
        width: 24px;
        height: 24px;
      }
    }
  }

  .go-to {
    position: fixed;
    top: 100px;
    left: calc(50% + (var(--workflow-dashboard-sidebar-width, 0px) / 2));
    transform: translateX(-50%);
    z-index: 100;

    input {
      background: var(--grey-dark);
      border: none;
      border-radius: 4px;
      padding: 18px 18px;
      color: var(--grey-lightest);
      width: 200px;
      height: 32px;
      font-size: 14px;
      font-family: var(--font-family);
      font-weight: 500;
      box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
      width: 500px;
    }

    .entries {
      border-radius: 4px;
      box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
      max-height: 300px;
      overflow-y: auto;
      width: 500px;

      .entry {
        cursor: pointer;

        .search-result-item {
          padding: 8px;
          border-radius: 4px;
          background: var(--grey-darkerish);

          .title {
            font-weight: 500;
            font-size: 16px;
            margin-bottom: 4px;
            display: inline;
          }

          .graph {
            font-size: 13px;
            color: var(--grey-light);
            margin-bottom: 4px;
            display: inline;
            margin-left: 8px;
          }

          .description {
            font-size: 14px;
            color: var(--grey-light);
            margin-bottom: 4px;
            display: inline;
            margin-left: 8px;
          }

          .data {
            font-size: 13px;
            color: var(--grey-light);
            display: inline;
            margin-left: 16px;
          }

          &.selected {
            background: var(--grey-darkish);
          }
        }
      }
    }
  }

  .highlighted {
    background: var(--highlighted-text);
    color: var(--highlighted-text-contrast);
  }
`;

export const NavigationBar: FC = () => {
  const navigationStack = useGraphHistoryNavigation();

  const [searching, setSearching] = useAtom(searchingGraphState);

  const [goToSearch, setGoToSearch] = useAtom(goToSearchState);

  function handleGoToKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      setGoToSearch({ searching: false, query: '', selectedIndex: 0, entries: [] });
    }

    if (e.key === 'ArrowDown') {
      setGoToSearch((state) => {
        const newIndex = state.selectedIndex + 1 >= state.entries.length ? 0 : state.selectedIndex + 1;

        return {
          ...state,
          selectedIndex: newIndex,
        };
      });
    }

    if (e.key === 'ArrowUp') {
      setGoToSearch((state) => {
        const newIndex = state.selectedIndex - 1 < 0 ? state.entries.length - 1 : state.selectedIndex - 1;

        return {
          ...state,
          selectedIndex: newIndex,
        };
      });
    }
  }

  return (
    <div css={styles}>
      {navigationStack.hasBackward ? (
        <Tooltip content="Go to previous graph" placement="bottom">
          <button onClick={navigationStack.navigateBack}>
            <LeftIcon />
          </button>
        </Tooltip>
      ) : (
        <div className="button-placeholder" />
      )}

      {navigationStack.hasForward ? (
        <Tooltip content="Go to next graph" placement="bottom">
          <button onClick={navigationStack.navigateForward}>
            <RightIcon />
          </button>
        </Tooltip>
      ) : (
        <div className="button-placeholder" />
      )}

      {searching.searching && (
        <div className="search">
          <input
            type="text"
            placeholder="Search..."
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={searching.query}
            onChange={(e) => setSearching({ searching: true, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearching({ searching: false, query: '' });
              }
            }}
          />
          <button className="stopSearching" onClick={() => setSearching({ searching: false, query: '' })}>
            <CrossIcon />
          </button>
        </div>
      )}

      {goToSearch.searching && (
        <div className="go-to">
          <div className="go-to-search">
            <input
              type="text"
              placeholder="Go to..."
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={goToSearch.query}
              onChange={(e) =>
                setGoToSearch((search) => ({
                  searching: true,
                  query: e.target.value,
                  selectedIndex: 0,
                  entries: search.entries,
                }))
              }
              onKeyDown={handleGoToKeyDown}
            />
          </div>
          <GoToSearchResults />
        </div>
      )}
    </div>
  );
};

const GoToSearchResults: FC = () => {
  const [goToSearch, setGoToSearch] = useAtom(goToSearchState);

  const results = useSearchProject(goToSearch.query, goToSearch.searching);

  useEffect(() => {
    setGoToSearch((search) => ({
      ...search,
      entries: results,
    }));
  }, [results.map((r) => r.item.id).join(','), setGoToSearch]);

  return (
    <div className="entries">
      {goToSearch.entries.map((entry, index) => (
        <div key={entry.item.id} className="entry">
          <SearchResultItem entry={entry} selected={index === goToSearch.selectedIndex} searchText={goToSearch.query} />
        </div>
      ))}
    </div>
  );
};

const SearchResultItem: FC<{
  entry: SearchedItem;
  searchText: string;
  selected: boolean;
}> = ({ entry, selected, searchText }) => {
  const project = useAtomValue(projectState);

  const goToNode = useGoToNode();

  useEffect(() => {
    if (selected) {
      const element = document.querySelector('.search-result-item.selected');
      element?.scrollIntoView({ block: 'nearest' });

      goToNode(entry.item.id as NodeId);
    }
  }, [selected, entry.item.id, goToNode]);

  return (
    <div className={clsx('search-result-item', { selected })}>
      <div className="title">
        <HighlightedText text={entry.item.title} searchText={searchText} />
      </div>
      <div className="graph">in {project.graphs[entry.item.containerGraph]?.metadata?.name ?? 'Unknown Graph'}</div>
      <div className="description">
        <HighlightedText text={entry.item.description} searchText={searchText} />
      </div>
      <div className="data">
        <HighlightedText text={entry.item.joinedData} searchText={searchText} />
      </div>
    </div>
  );
};

interface HighlightedTextProps {
  text: string;
  searchText: string;
  className?: string;
  highlightClassName?: string;
  contextAmount?: number;
}

interface Range {
  start: number;
  end: number;
}

const HighlightedText: FC<HighlightedTextProps> = ({
  text,
  searchText,
  className = '',
  highlightClassName = 'highlighted',
  contextAmount = 100,
}) => {
  if (!searchText.trim() || !text) {
    return <span className={className}>{text}</span>;
  }

  const searchWords = searchText
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (searchWords.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const ranges: Range[] = [];

  searchWords.forEach((word) => {
    const textLower = text.toLowerCase();
    let startIndex = 0;

    while (startIndex < text.length) {
      const matchIndex = textLower.indexOf(word, startIndex);
      if (matchIndex === -1) break;

      ranges.push({
        start: matchIndex,
        end: matchIndex + word.length,
      });
      startIndex = matchIndex + 1;
    }
  });

  if (ranges.length === 0) {
    return <span className={className}>{text.substring(0, contextAmount)}</span>;
  }

  const sortedRanges = ranges.sort((a, b) => a.start - b.start);

  const mergedRanges = sortedRanges.reduce<Range[]>((acc, curr) => {
    if (acc.length === 0) return [curr];

    const prev = acc[acc.length - 1]!;

    if (curr.start <= prev.end) {
      acc[acc.length - 1] = {
        start: prev.start,
        end: Math.max(prev.end, curr.end),
      };
    } else {
      acc.push(curr);
    }
    return acc;
  }, []);

  const firstMatch = mergedRanges[0]!;
  const lastMatch = mergedRanges[mergedRanges.length - 1];

  if (!firstMatch || !lastMatch) {
    return <span className={className}>{text}</span>;
  }

  const visibleStart = Math.max(0, firstMatch.start - contextAmount);
  const visibleEnd = Math.min(text.length, lastMatch.end + contextAmount);

  const adjustedRanges = mergedRanges.map((range) => ({
    start: range.start - visibleStart,
    end: range.end - visibleStart,
  }));

  const trimmedText = text.slice(visibleStart, visibleEnd);
  const showStartEllipsis = visibleStart > 0;
  const showEndEllipsis = visibleEnd < text.length;

  const segments: JSX.Element[] = [];
  let lastIndex = 0;

  if (showStartEllipsis) {
    segments.push(<span key="start-ellipsis">...</span>);
  }

  adjustedRanges.forEach((range, idx) => {
    if (range.start > lastIndex) {
      segments.push(<span key={`text-${idx}`}>{trimmedText.substring(lastIndex, range.start)}</span>);
    }

    segments.push(
      <span key={`highlight-${idx}`} className={highlightClassName}>
        {trimmedText.substring(range.start, range.end)}
      </span>,
    );

    lastIndex = range.end;
  });

  if (lastIndex < trimmedText.length) {
    segments.push(<span key={`text-${adjustedRanges.length}`}>{trimmedText.substring(lastIndex)}</span>);
  }

  if (showEndEllipsis) {
    segments.push(<span key="end-ellipsis">...</span>);
  }

  return <span className={className}>{segments}</span>;
};
