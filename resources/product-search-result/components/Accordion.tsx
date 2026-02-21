import type React from "react";
import { useState } from "react";
import { AccordionItem } from "./AccordionItem";

export interface AccordionItemData {
	question: string;
	answer: string;
}

interface AccordionProps {
	items: AccordionItemData[];
}

export const Accordion: React.FC<AccordionProps> = ({ items }) => {
	const [openAccordionIndex, setOpenAccordionIndex] = useState<number | null>(
		null,
	);

	return (
		<div className="p-8 pt-4 border-t border-subtle mt-4">
			<div className="rounded-lg border border-default overflow-hidden">
				{items.map((item, accordionItemIndex) => (
					<AccordionItem
						key={`${item.question}-${item.answer}`}
						question={item.question}
						answer={item.answer}
						isOpen={openAccordionIndex === accordionItemIndex}
						onToggle={() =>
							setOpenAccordionIndex(
								openAccordionIndex === accordionItemIndex
									? null
									: accordionItemIndex,
							)
						}
					/>
				))}
			</div>
		</div>
	);
};
