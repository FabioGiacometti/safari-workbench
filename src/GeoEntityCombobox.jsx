import { useState, useEffect, useRef, useCallback, useId } from 'react'

// ---------------------------------------------------------------------------
// GeoEntityCombobox
//
// Searchable combobox for selecting a geo entity.
//
// Props:
//   apiFetch       — (path, method?, body?) => Promise  — same helper as App.jsx
//   candidates     — Array<{id, display_name, level, country_code, region}>
//                    Pipeline-suggested options shown before the user types.
//                    May be empty. Never pre-selected silently.
//   value          — string | null   — controlled selected entity ID
//   onChange       — (id | null) => void
//   disabled       — bool
//   placeholder    — string  (default: "Buscar ciudad o región")
//   'data-testid'  — forwarded to the root element for tests
// ---------------------------------------------------------------------------

const MIN_QUERY_LEN = 2
const DEBOUNCE_MS   = 250

export default function GeoEntityCombobox({
  apiFetch,
  candidates = [],
  value,
  onChange,
  disabled = false,
  placeholder = 'Buscar ciudad o región',
  'data-testid': testId,
}) {
  const inputId   = useId()
  const listId    = useId()

  const [inputText,    setInputText]    = useState('')
  const [results,      setResults]      = useState([])   // search results
  const [isOpen,       setIsOpen]       = useState(false)
  const [loadState,    setLoadState]    = useState('idle') // idle | loading | error
  const [errorMsg,     setErrorMsg]     = useState('')
  const [activeIdx,    setActiveIdx]    = useState(-1)   // keyboard cursor

  const inputRef   = useRef(null)
  const listRef    = useRef(null)
  const debounceId = useRef(null)
  const latestQuery = useRef('')

  // Derive display label for the currently selected value
  const selectedEntity = value
    ? [...candidates, ...results].find(e => e.id === value) ?? null
    : null

  // When a value is selected, show its name in the input
  useEffect(() => {
    if (value && selectedEntity) {
      setInputText(selectedEntity.display_name)
    } else if (!value) {
      setInputText('')
    }
  }, [value, selectedEntity?.display_name])

  const doSearch = useCallback(async (q) => {
    latestQuery.current = q

    if (q.length < MIN_QUERY_LEN) {
      setResults([])
      setLoadState('idle')
      return
    }

    setLoadState('loading')
    try {
      const res = await apiFetch(`geo-entities?q=${encodeURIComponent(q)}`)
      // Discard stale responses
      if (latestQuery.current !== q) return
      setResults(res.entities ?? [])
      setLoadState('idle')
      setErrorMsg('')
    } catch (err) {
      if (latestQuery.current !== q) return
      setLoadState('error')
      setErrorMsg(err?.message ?? 'Error al buscar')
    }
  }, [apiFetch])

  function handleInputChange(e) {
    const q = e.target.value
    setInputText(q)

    // Typing clears any current selection so the caller knows value is dirty
    if (value) onChange(null)

    setActiveIdx(-1)
    setIsOpen(true)

    clearTimeout(debounceId.current)
    debounceId.current = setTimeout(() => doSearch(q), DEBOUNCE_MS)
  }

  function handleInputFocus() {
    setIsOpen(true)
  }

  function handleInputBlur(e) {
    // Blur fires before list item mousedown — delay so click can register
    setTimeout(() => {
      if (listRef.current?.contains(document.activeElement)) return
      setIsOpen(false)
      // If user blurred without selecting and had cleared the value, restore
      // display label to the previously confirmed selection (if any)
      if (value && selectedEntity) {
        setInputText(selectedEntity.display_name)
      }
    }, 150)
  }

  function handleSelect(entity) {
    onChange(entity.id)
    setInputText(entity.display_name)
    setIsOpen(false)
    setActiveIdx(-1)
    inputRef.current?.focus()
  }

  function handleClear(e) {
    e.preventDefault()
    onChange(null)
    setInputText('')
    setResults([])
    setActiveIdx(-1)
    inputRef.current?.focus()
  }

  function handleKeyDown(e) {
    const options = visibleOptions()
    if (!isOpen || options.length === 0) {
      if (e.key === 'ArrowDown') { setIsOpen(true); e.preventDefault() }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.min(activeIdx + 1, options.length - 1)
      setActiveIdx(next)
      scrollOptionIntoView(next)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = Math.max(activeIdx - 1, 0)
      setActiveIdx(prev)
      scrollOptionIntoView(prev)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIdx >= 0 && activeIdx < options.length) {
        handleSelect(options[activeIdx])
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false)
      setActiveIdx(-1)
    }
  }

  function scrollOptionIntoView(idx) {
    const list = listRef.current
    if (!list) return
    const item = list.children[idx]
    item?.scrollIntoView({ block: 'nearest' })
  }

  // What appears in the dropdown: search results if query >= MIN_QUERY_LEN,
  // otherwise pipeline candidates. Never the full unfiltered registry.
  function visibleOptions() {
    if (inputText.length >= MIN_QUERY_LEN) return results
    return candidates
  }

  const options = visibleOptions()
  const showDropdown = isOpen && !disabled

  return (
    <div className="relative" data-testid={testId}>
      {/* Input */}
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeIdx >= 0 ? `${listId}-opt-${activeIdx}` : undefined}
          value={inputText}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          className={[
            'w-full bg-white border text-gray-900 text-xs rounded px-2 py-1.5 pr-7',
            'focus:outline-none focus:border-blue-400',
            disabled ? 'opacity-50 cursor-not-allowed' : 'border-gray-300',
            value ? 'border-blue-400' : '',
          ].join(' ')}
        />
        {/* Loading spinner / clear button */}
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
          {loadState === 'loading' && (
            <span className="text-gray-400 text-xs">…</span>
          )}
          {value && !disabled && (
            <button
              onMouseDown={handleClear}
              className="text-gray-400 hover:text-gray-700 text-xs leading-none"
              tabIndex={-1}
              aria-label="Limpiar selección"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg max-h-56 overflow-y-auto"
        >
          {/* Hint line when showing pipeline candidates (before user has typed) */}
          {inputText.length < MIN_QUERY_LEN && candidates.length > 0 && (
            <li className="px-3 py-1.5 text-xs text-gray-400 border-b border-gray-100 select-none">
              Sugerencias del sistema — escribe para buscar más
            </li>
          )}

          {/* Options */}
          {options.map((entity, idx) => {
            const isActive   = idx === activeIdx
            const isSelected = entity.id === value
            const subtitle   = [entity.region, entity.country_code?.toUpperCase()]
              .filter(Boolean).join(' · ')
            return (
              <li
                key={entity.id}
                id={`${listId}-opt-${idx}`}
                role="option"
                aria-selected={isSelected}
                onMouseDown={() => handleSelect(entity)}
                className={[
                  'px-3 py-2 cursor-pointer select-none',
                  isActive   ? 'bg-blue-50'     : 'hover:bg-gray-50',
                  isSelected ? 'text-blue-700'   : 'text-gray-900',
                ].join(' ')}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium">{entity.display_name}</span>
                  <span className="text-xs text-gray-400">{entity.level}</span>
                  {isSelected && <span className="ml-auto text-xs text-blue-500">✓</span>}
                </div>
                {subtitle && (
                  <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>
                )}
              </li>
            )
          })}

          {/* Empty state */}
          {options.length === 0 && loadState !== 'loading' && inputText.length >= MIN_QUERY_LEN && (
            <li className="px-3 py-2 text-xs text-gray-400 select-none">
              No se encontró ninguna entidad geográfica con ese nombre.
            </li>
          )}

          {/* Prompt to type when no candidates and nothing typed */}
          {options.length === 0 && loadState !== 'loading' && inputText.length < MIN_QUERY_LEN && candidates.length === 0 && (
            <li className="px-3 py-2 text-xs text-gray-400 select-none">
              Escribe al menos 2 caracteres para buscar.
            </li>
          )}

          {/* Error state */}
          {loadState === 'error' && (
            <li className="px-3 py-2 text-xs text-red-600 select-none">
              {errorMsg}
            </li>
          )}
        </ul>
      )}

      {/* Selected entity summary (shown below the input when a value is confirmed) */}
      {value && selectedEntity && (
        <p className="mt-1 text-xs text-blue-700">
          {selectedEntity.display_name}
          {selectedEntity.country_code && (
            <span className="text-gray-400 ml-1">
              · {selectedEntity.level} · {selectedEntity.country_code.toUpperCase()}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
