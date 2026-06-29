import { useState, useRef, useEffect } from 'react'

/**
 * Multi-select genre combobox.
 *
 * Props:
 *   selectedGenres    — GenreSummary[] currently selected
 *   availableGenres   — GenreSummary[] full controlled vocabulary
 *   onChange(genres)  — called with updated GenreSummary[] on any change
 *   disabled          — boolean, blocks interaction during save
 *
 * GenreSummary: { id: number, slug: string, name: string }
 */
export default function GenreSelector({ selectedGenres = [], availableGenres = [], onChange, disabled = false }) {
  const [filterText, setFilterText] = useState('')
  const [open, setOpen]             = useState(false)
  const inputRef = useRef(null)
  const dropdownRef = useRef(null)

  const selectedIds = new Set(selectedGenres.map(g => g.id))

  const unselected = availableGenres.filter(g => !selectedIds.has(g.id))
  const filtered   = filterText.trim()
    ? unselected.filter(g => g.name.toLowerCase().includes(filterText.toLowerCase()))
    : unselected

  function addGenre(genre) {
    onChange([...selectedGenres, genre])
    setFilterText('')
    inputRef.current?.focus()
  }

  function removeGenre(genreId) {
    onChange(selectedGenres.filter(g => g.id !== genreId))
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      setOpen(false)
      setFilterText('')
    }
    if (e.key === 'Backspace' && filterText === '' && selectedGenres.length > 0) {
      removeGenre(selectedGenres[selectedGenres.length - 1].id)
    }
    if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault()
      addGenre(filtered[0])
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        inputRef.current && !inputRef.current.contains(e.target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className="relative">
      {/* Selected genre badges */}
      <div className="flex flex-wrap gap-1 mb-1.5 min-h-[20px]">
        {selectedGenres.length === 0 && (
          <span className="text-[10px] text-gray-400 italic">Sin géneros seleccionados</span>
        )}
        {selectedGenres.map(g => (
          <span
            key={g.id}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-[10px] text-blue-800 font-medium"
          >
            {g.name}
            {!disabled && (
              <button
                type="button"
                onClick={() => removeGenre(g.id)}
                className="ml-0.5 text-blue-400 hover:text-blue-700 leading-none"
                aria-label={`Quitar ${g.name}`}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={filterText}
        disabled={disabled}
        placeholder={unselected.length === 0 ? 'Todos los géneros seleccionados' : 'Buscar género…'}
        onChange={e => { setFilterText(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:border-blue-400 font-mono disabled:opacity-50 disabled:bg-gray-50"
      />

      {/* Dropdown */}
      {open && filtered.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-20 mt-0.5 w-full bg-white border border-gray-200 rounded shadow-md max-h-48 overflow-y-auto"
        >
          {filtered.map(g => (
            <button
              key={g.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); addGenre(g) }}
              className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-blue-50 hover:text-blue-900 transition-colors"
            >
              {g.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
