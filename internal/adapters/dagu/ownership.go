package dagu

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sort"
	"strings"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"gopkg.in/yaml.v3"
)

const (
	labelManaged      = "aegis.managed"
	labelOwnerKind    = "aegis.owner.kind"
	labelOwnerVersion = "aegis.owner.version"
	labelFolderKey    = "aegis.folder.key"
)

type ownershipStatus uint8

const (
	ownershipMissing ownershipStatus = iota
	ownershipMatches
	ownershipConflicts
)

func folderOwnershipKey(folderUID string) string {
	sum := sha256.Sum256([]byte(folderUID))
	return hex.EncodeToString(sum[:])
}

func expectedOwnershipLabels(folderUID string) map[string]string {
	return map[string]string{
		labelManaged:      "true",
		labelOwnerKind:    "folder",
		labelOwnerVersion: "1",
		labelFolderKey:    folderOwnershipKey(folderUID),
	}
}

func labelsOwnedByFolder(labels []string, folderUID string) bool {
	return labelsOwnershipStatus(labels, folderUID) == ownershipMatches
}

func labelsOwnershipStatus(labels []string, folderUID string) ownershipStatus {
	parsed := make(map[string]string, len(labels))
	for _, label := range labels {
		key, value, found := strings.Cut(strings.TrimSpace(label), "=")
		if found {
			parsed[strings.ToLower(strings.TrimSpace(key))] = strings.ToLower(strings.TrimSpace(value))
		}
	}
	expected := expectedOwnershipLabels(folderUID)
	hasReserved := false
	for key := range expected {
		if _, exists := parsed[key]; exists {
			hasReserved = true
			break
		}
	}
	if !hasReserved {
		return ownershipMissing
	}
	for key, value := range expected {
		if parsed[key] != value {
			return ownershipConflicts
		}
	}
	return ownershipMatches
}

func specOwnedByFolder(spec, folderUID string) bool {
	return specOwnershipStatus(spec, folderUID) == ownershipMatches
}

func specOwnershipStatus(spec, folderUID string) ownershipStatus {
	var document yaml.Node
	if yaml.Unmarshal([]byte(spec), &document) != nil || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return ownershipConflicts
	}
	root := document.Content[0]
	for index := 0; index+1 < len(root.Content); index += 2 {
		if root.Content[index].Value != "labels" {
			continue
		}
		labels, err := decodeLabels(root.Content[index+1])
		if err != nil {
			return ownershipConflicts
		}
		serialized := make([]string, 0, len(labels))
		for key, value := range labels {
			serialized = append(serialized, key+"="+value)
		}
		return labelsOwnershipStatus(serialized, folderUID)
	}
	return ownershipMissing
}

func bindFolderOwnership(spec []byte, folderUID string) ([]byte, error) {
	if strings.TrimSpace(folderUID) == "" {
		return nil, errors.New("trusted Folder context is required")
	}
	var document yaml.Node
	if err := yaml.Unmarshal(spec, &document); err != nil {
		return nil, err
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("playbook YAML must be a mapping")
	}
	root := document.Content[0]
	labels := map[string]string{}
	labelsIndex := -1
	for index := 0; index+1 < len(root.Content); index += 2 {
		if root.Content[index].Value == "labels" {
			labelsIndex = index + 1
			var err error
			labels, err = decodeLabels(root.Content[labelsIndex])
			if err != nil {
				return nil, err
			}
			break
		}
	}
	expected := expectedOwnershipLabels(folderUID)
	for key, value := range labels {
		if strings.HasPrefix(strings.ToLower(key), "aegis.") && expected[strings.ToLower(key)] != strings.ToLower(value) {
			return nil, errors.New("playbook YAML contains conflicting reserved Aegis labels")
		}
	}
	for key, value := range expected {
		labels[key] = value
	}
	labelsNode := encodeLabels(labels)
	if labelsIndex >= 0 {
		root.Content[labelsIndex] = labelsNode
	} else {
		root.Content = append([]*yaml.Node{{Kind: yaml.ScalarNode, Tag: "!!str", Value: "labels"}, labelsNode}, root.Content...)
	}
	return yaml.Marshal(&document)
}

func decodeLabels(node *yaml.Node) (map[string]string, error) {
	labels := map[string]string{}
	var add func(*yaml.Node) error
	add = func(value *yaml.Node) error {
		switch value.Kind {
		case yaml.MappingNode:
			for index := 0; index+1 < len(value.Content); index += 2 {
				labels[value.Content[index].Value] = value.Content[index+1].Value
			}
		case yaml.SequenceNode:
			for _, item := range value.Content {
				if err := add(item); err != nil {
					return err
				}
			}
		case yaml.ScalarNode:
			parts := strings.Split(value.Value, ",")
			if len(parts) == 1 && strings.Contains(value.Value, "=") {
				parts = strings.Fields(value.Value)
			}
			for _, part := range parts {
				key, labelValue, found := strings.Cut(strings.TrimSpace(part), "=")
				if !found || strings.TrimSpace(key) == "" {
					return errors.New("labels must use key=value entries")
				}
				labels[strings.TrimSpace(key)] = strings.TrimSpace(labelValue)
			}
		default:
			return errors.New("labels must be a map, sequence, or string")
		}
		return nil
	}
	return labels, add(node)
}

func encodeLabels(labels map[string]string) *yaml.Node {
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for _, key := range keys {
		node.Content = append(node.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: labels[key]},
		)
	}
	return node
}

func ownershipNotFound() error {
	return &domain.AppError{Code: domain.ErrorNotFound, Message: "playbook not found"}
}
