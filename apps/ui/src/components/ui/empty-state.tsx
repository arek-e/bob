import { Card, CardContent, CardTitle } from "~/components/ui/card"
import { styles } from "~/lib/styles"

export function EmptyState(props: { title: string; detail: string }) {
  return (
    <Card class={styles.emptyState}>
      <CardContent>
        <CardTitle>{props.title}</CardTitle>
        <p class={styles.hint}>{props.detail}</p>
      </CardContent>
    </Card>
  )
}
