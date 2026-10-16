import { SymbolView, type SymbolViewProps } from 'expo-symbols'

/** SF Symbols at the design's sizes (§5.7): 16 in lists, 18 in toolbars; 22 in touch bars. */
export function Icon({
  name,
  size = 18,
  color,
  weight = 'medium',
}: {
  name: SymbolViewProps['name']
  size?: number
  color: string
  weight?: SymbolViewProps['weight']
}) {
  return <SymbolView name={name} size={size} tintColor={color} weight={weight} />
}
